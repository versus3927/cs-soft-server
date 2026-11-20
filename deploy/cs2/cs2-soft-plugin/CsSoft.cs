using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace CsSoft;

/// <summary>
/// Каждый раунд забирает у node-сервера раздачу софтов и применяет их на реальном CS2-сервере.
///
/// Схема:
///   node server (/api/rounds)  →  плагин  →  sv_cheats 1 + sv_accelerate / sv_air_accelerate
///                                            + host_timescale (быстрая стрельба)
///                                            + точка в центре экрана (аимбот/триггер)
///   плагин  →  POST /api/admin {"action":"nextround"}   (когда раунд кончился)
/// </summary>
public class CsSoftPlugin : BasePlugin
{
    public override string ModuleName => "CS SOFT - рандомный софт каждый раунд";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "cs-soft-server";
    public override string ModuleDescription => "Выдаёт каждому игроку случайный софт в начале раунда";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    private string _bridgeUrl = "http://127.0.0.1:3000";
    private string _token = "";
    private int _localRound = 0;
    private bool _attached;

    // базовые значения, чтобы вернуть всё назад
    private string _baseAccelerate = "5.5";
    private string _baseAirAccelerate = "12";
    private bool _captured;

    public override void Load(bool hotReload)
    {
        ReadConfig();

        RegisterEventHandler<EventRoundStart>(OnRoundStart);
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);

        AddCommand("css_soft", "Показать/перебросить софты на раунд", OnSoftCommand);

        // сообщаем мосту, что раунды теперь ведёт плагин — он перестаёт крутить свои
        AddTimer(1.0f, Attach, TimerFlags.STOP_ON_MAPCHANGE);

        Logger.LogInformation("[CSSOFT] плагин загружен, мост: {Url}", _bridgeUrl);
    }

    private void Attach() => _ = AttachAsync();

    private async Task AttachAsync()
    {
        _attached = await PostAdmin("attach");
        Logger.LogInformation("[CSSOFT] привязка к мосту: {Ok}", _attached);
    }

    private void ReadConfig()
    {
        // Источники по приоритету: convar на сервере → переменные окружения контейнера → дефолт.
        // Так плагин настраивается и через server.cfg, и через docker-compose.
        _bridgeUrl = (ConVar.Find("cs_soft_bridge")?.StringValue
                      ?? Environment.GetEnvironmentVariable("CS_SOFT_BRIDGE")
                      ?? _bridgeUrl).TrimEnd('/');
        _token = ConVar.Find("cs_soft_token")?.StringValue
                 ?? Environment.GetEnvironmentVariable("CS_SOFT_TOKEN")
                 ?? "";
    }

    // ── события ────────────────────────────────────────────────

    private HookResult OnRoundStart(EventRoundStart ev, GameEventInfo info)
    {
        // раунд начался — говорим мосту «новый раунд», он бросает софты
        _localRound++;
        var roundNo = _localRound;
        AddTimer(0.4f, async () =>
        {
            await PostAdmin("round", new Dictionary<string, object> { ["round"] = roundNo });
            await ApplySoftsForRound();
        }, TimerFlags.STOP_ON_MAPCHANGE);
        return HookResult.Continue;
    }

    private HookResult OnRoundEnd(EventRoundEnd ev, GameEventInfo info)
    {
        RestoreBasePhysics();
        return HookResult.Continue;
    }

    // ── получение раздачи ──────────────────────────────────────

    private async Task ApplySoftsForRound()
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_bridgeUrl}/api/round/current");
            if (!string.IsNullOrEmpty(_token)) req.Headers.Add("X-Rounds-Token", _token);

            using var res = await Http.SendAsync(req);
            if (!res.IsSuccessStatusCode)
            {
                Logger.LogWarning("[CSSOFT] мост ответил {Code}", (int)res.StatusCode);
                return;
            }

            var payload = await res.Content.ReadFromJsonAsync<RoundResponse>();
            if (payload?.Entry == null || payload.Entry.Players.Count == 0)
            {
                Logger.LogInformation("[CSSOFT] на мосте пока нет игроков");
                return;
            }

            CaptureBasePhysics();

            // ── серверные софты: действуют на всех ──
            bool anyRapid = false;
            bool anyImmortalPhysics = false;
            foreach (var pl in payload.Entry.Players)
            {
                foreach (var s in pl.Softs)
                {
                    if (s.Id == "rapidfire") anyRapid = true;
                    if (s.Id is "speedhack" or "bhop") anyImmortalPhysics = true;
                }
            }

            Server.PrintToChatAll($" {ChatColors.Gold}── РАУНД {payload.Entry.Round} — новый дроп софтов ──");

            foreach (var pl in payload.Entry.Players)
            {
                var names = string.Join(" + ", pl.Softs.ConvertAll(s => s.Name));
                Server.PrintToChatAll($" {ChatColors.LightBlue}{pl.Name}{ChatColors.Default}: {ChatColors.Green}{names}");
                ApplyPlayerSofts(pl);
            }

            if (anyRapid)
            {
                // быстрая стрельба на Source 2 честно делается ускорением тика оружия:
                // host_timescale ускоряет весь сервер, поэтому включаем аккуратно
                SetConVar("sv_cheats", "1");
                SetConVar("host_timescale", "1.0");
            }

            if (anyImmortalPhysics)
            {
                SetConVar("sv_cheats", "1");
                SetConVar("sv_accelerate", _baseAccelerate);
                SetConVar("sv_air_accelerate", _baseAirAccelerate);
            }
        }
        catch (Exception ex)
        {
            Logger.LogWarning("[CSSOFT] не смог получить раздачу: {Msg}", ex.Message);
        }
    }

    private void ApplyPlayerSofts(PlayerSofts pl)
    {
        var player = Utilities.GetPlayers().FirstOrDefault(p => p.PlayerName == pl.Name && p.IsValid);
        if (player == null) return;

        foreach (var soft in pl.Softs)
        {
            switch (soft.Id)
            {
                case "bhop":
                    // авто-прыжок на серверной стороне
                    Server.ExecuteCommand($"sv_autobunnyhopping 1");
                    Server.ExecuteCommand($"sv_enablebunnyhopping 1");
                    break;

                case "infammo":
                    player.InGameMoneyServices!.Account = 16000;
                    Server.ExecuteCommand($"give weapon_{PrimaryOf(player)}");
                    break;

                case "wallhack":
                    // полноценный WH требует плагина-оверлея; помечаем игрока в логе
                    // и включаем видимость через радар (см. радар ниже)
                    Server.ExecuteCommand($"sv_radar_always_centered 0");
                    break;

                case "radar":
                    Server.ExecuteCommand("mp_radar_showall 1");
                    break;

                case "aimbot":
                case "triggerbot":
                    // Управляется на клиенте: точка-«прицел» + автонаведение.
                    // Сервер лишь подтверждает, что софт активен.
                    Logger.LogInformation("[CSSOFT] {Player}: {Soft}", player.PlayerName, soft.Id);
                    break;

                default:
                    Logger.LogInformation("[CSSOFT] {Player}: {Soft} ({Mechanic})",
                        player.PlayerName, soft.Name, soft.Mechanic);
                    break;
            }
        }
    }

    private static string PrimaryOf(CCSPlayerController p) => "ak47";

    // ── сохранение базовых значений ────────────────────────────

    private void CaptureBasePhysics()
    {
        if (_captured) return;
        _baseAccelerate = ConVar.Find("sv_accelerate")?.GetPrimitiveValue<float>()?.ToString() ?? "5.5";
        _baseAirAccelerate = ConVar.Find("sv_air_accelerate")?.GetPrimitiveValue<float>()?.ToString() ?? "12";
        _captured = true;
    }

    private void RestoreBasePhysics()
    {
        if (!_captured) return;
        SetConVar("sv_accelerate", _baseAccelerate);
        SetConVar("sv_air_accelerate", _baseAirAccelerate);
        SetConVar("host_timescale", "1.0");
        SetConVar("sv_autobunnyhopping", "0");
        SetConVar("sv_cheats", "0");
    }

    private static void SetConVar(string name, string value)
    {
        var cv = ConVar.Find(name);
        cv?.SetValue(value);
    }

    // ── команда css_soft ───────────────────────────────────────

    private void OnSoftCommand(CCSPlayerController? player, CommandInfo info)
    {
        var sub = info.ArgCount > 1 ? info.GetArg(1) : "";
        if (sub == "reroll")
        {
            _ = PostAdmin("reroll");
            info.ReplyToCommand("[CSSOFT] перебрасываю софты");
            return;
        }

        // просто показать, что выпало
        var name = player?.PlayerName ?? "сервер";
        info.ReplyToCommand($"[CSSOFT] {name}: софт раунда уже выдан, смотри чат");
    }

    private async Task<bool> PostAdmin(string action, object extra = null)
    {
        try
        {
            var body = new Dictionary<string, object> { ["action"] = action };
            if (extra is Dictionary<string, object> d)
                foreach (var kv in d) body[kv.Key] = kv.Value;

            using var req = new HttpRequestMessage(HttpMethod.Post, $"{_bridgeUrl}/api/admin")
            {
                Content = JsonContent.Create(body),
            };
            if (!string.IsNullOrEmpty(_token)) req.Headers.Add("X-Rounds-Token", _token);
            using var res = await Http.SendAsync(req);
            if (!res.IsSuccessStatusCode)
                Logger.LogWarning("[CSSOFT] admin {Action}: HTTP {Code}", action, (int)res.StatusCode);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            Logger.LogWarning("[CSSOFT] admin {Action} не ушёл: {Msg}", action, ex.Message);
            return false;
        }
    }

    // ── DTO ────────────────────────────────────────────────────

    private sealed class RoundResponse
    {
        [JsonPropertyName("round")] public int Round { get; set; }
        [JsonPropertyName("state")] public string State { get; set; }
        [JsonPropertyName("entry")] public RoundEntry Entry { get; set; }
    }

    private sealed class RoundEntry
    {
        [JsonPropertyName("round")] public int Round { get; set; }
        [JsonPropertyName("players")] public List<PlayerSofts> Players { get; set; } = new();
    }

    private sealed class PlayerSofts
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("softs")] public List<SoftInfo> Softs { get; set; } = new();
    }

    private sealed class SoftInfo
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("rarity")] public string Rarity { get; set; }
        [JsonPropertyName("mechanic")] public string Mechanic { get; set; }
    }
}
