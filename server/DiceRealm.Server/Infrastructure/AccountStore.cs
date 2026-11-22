using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// One atomically published account document, independent of game transactions. The
// existing DataDirectory lease excludes other writers; this gate serializes requests.
public sealed class AccountStore
{
    public const string AdminId = "00000000-0000-4000-8000-000000000001";
    public const int PasswordIterations = 600000;
    // Unknown and disabled accounts are checked against this throwaway hash, so they cost the same slow work.
    private static readonly string DecoySalt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
    private static readonly string DecoyHash = HashPassword(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)), DecoySalt);
    private readonly string path;
    private readonly object gate = new();

    private sealed record StoredUser(string Id, string Username, bool Disabled, string Salt, string PasswordHash);
    private sealed record StoredSession(string TokenHash, string UserId, DateTimeOffset ExpiresAt);
    private sealed class Document
    {
        public int SchemaVersion { get; init; } = 1;
        public required string FingerprintKey { get; init; }
        public List<StoredUser> Users { get; init; } = [];
        public List<StoredSession> Sessions { get; init; } = [];
    }

    // A new data directory gets the only admin. Its first password comes from Accounts:InitialAdminPassword
    // (environment Accounts__InitialAdminPassword); without one a random password is generated and logged
    // once. An existing directory keeps its stored accounts; the setting is then ignored.
    public AccountStore(DataDirectory directory, IConfiguration configuration, ILogger<AccountStore> logger)
    {
        path = Path.Combine(directory.Root, "accounts.json");
        lock (gate)
        {
            if (File.Exists(path)) { _ = Read(); return; }
            string? password = configuration["Accounts:InitialAdminPassword"];
            bool generated = string.IsNullOrEmpty(password);
            if (generated) password = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(12));
            else ValidatePassword(password!);
            string salt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            JsonFiles.Write(path, new Document
            {
                FingerprintKey = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),
                Users = [new(AdminId, "admin", false, salt, HashPassword(password!, salt))]
            });
            if (generated) logger.LogWarning("已创建管理员账户 admin，初始密码：{Password}。只显示这一次，登录后请在账户菜单修改。", password);
        }
    }

    public AccountLoginResponse Login(string username, string password)
    {
        username = Username(username);
        ValidatePassword(password);
        lock (gate)
        {
            var document = Read();
            var user = document.Users.FirstOrDefault(u => string.Equals(u.Username, username, StringComparison.OrdinalIgnoreCase));
            // Unknown and disabled accounts still do the same slow password work.
            bool matches = Verify(password, user?.Salt ?? DecoySalt, user?.PasswordHash ?? DecoyHash);
            if (user is null || user.Disabled || !matches) throw Unauthorized();
            string token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            document.Sessions.RemoveAll(s => s.ExpiresAt <= DateTimeOffset.UtcNow);
            document.Sessions.Add(new(JsonFiles.Hash(token), user.Id, DateTimeOffset.UtcNow.AddDays(30)));
            JsonFiles.Write(path, document);
            return new(token, View(user));
        }
    }

    public AccountUser Require(string token)
    {
        lock (gate) return View(Authenticated(Read(), token));
    }
    public AccountUser RequireAdmin(string token)
    {
        var user = Require(token);
        if (!user.IsAdmin) throw Forbidden();
        return user;
    }
    // Null means this is not an active account session, so the campaign may check its
    // original Unity capability. No caller-provided actor/role is accepted anywhere.
    internal AccountUser? TryAuthenticate(string token) => TryAuthenticateHash(ValidHex(token, 64) ? JsonFiles.Hash(token) : "");

    // Internal revocable delegation lookup. This hash is never accepted by an HTTP login.
    internal AccountUser? TryAuthenticateHash(string hash)
    {
        lock (gate)
        {
            var document = Read();
            var session = document.Sessions.FirstOrDefault(s => s.TokenHash == hash && s.ExpiresAt > DateTimeOffset.UtcNow);
            var user = session is null ? null : document.Users.Single(u => u.Id == session.UserId);
            return user is null || user.Disabled ? null : View(user);
        }
    }
    internal byte[] RoomFingerprintKey(string userId, string campaignId)
    {
        lock (gate) return HMACSHA256.HashData(Convert.FromHexString(Read().FingerprintKey),
            Encoding.UTF8.GetBytes("account-room:" + userId + ":" + campaignId));
    }
    internal Dictionary<string, string> Usernames()
    {
        lock (gate) return Read().Users.ToDictionary(u => u.Id, u => u.Username);
    }

    public void Logout(string token)
    {
        lock (gate)
        {
            var document = Read();
            _ = Authenticated(document, token);
            string hash = JsonFiles.Hash(token);
            document.Sessions.RemoveAll(s => s.TokenHash == hash);
            JsonFiles.Write(path, document);
        }
    }
    public AccountUser[] Users(string token)
    {
        lock (gate)
        {
            var document = Read();
            Admin(document, token);
            return document.Users.OrderBy(u => u.Id != AdminId).ThenBy(u => u.Username, StringComparer.OrdinalIgnoreCase).Select(View).ToArray();
        }
    }
    public AccountUser Create(string token, string username, string password)
    {
        lock (gate)
        {
            var document = Read();
            Admin(document, token);
            username = Username(username);
            ValidatePassword(password);
            if (document.Users.Any(u => string.Equals(u.Username, username, StringComparison.OrdinalIgnoreCase)))
                throw new GameException("account_exists", "此用户名已存在。", 409);
            string salt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            var user = new StoredUser(Guid.NewGuid().ToString(), username, false, salt, HashPassword(password, salt));
            document.Users.Add(user);
            JsonFiles.Write(path, document);
            return View(user);
        }
    }
    public AccountUser SetDisabled(string token, string id, bool disabled)
    {
        lock (gate)
        {
            var document = Read();
            Admin(document, token);
            var user = FindUser(document, id);
            if (user.Id == AdminId) throw new GameException("admin_protected", "不能禁用管理员自身。", 403);
            var updated = user with { Disabled = disabled };
            document.Users[document.Users.IndexOf(user)] = updated;
            if (disabled) document.Sessions.RemoveAll(s => s.UserId == id);
            JsonFiles.Write(path, document);
            return View(updated);
        }
    }
    public void ResetPassword(string token, string id, string password)
    {
        lock (gate)
        {
            var document = Read();
            Admin(document, token);
            var user = FindUser(document, id);
            if (user.Id == AdminId) throw new GameException("admin_protected", "请通过本人修改密码更新管理员密码。", 403);
            ReplacePassword(document, user, password);
            JsonFiles.Write(path, document);
        }
    }
    public void ChangePassword(string token, string currentPassword, string password)
    {
        lock (gate)
        {
            var document = Read();
            var user = Authenticated(document, token);
            ValidatePassword(currentPassword);
            if (!Verify(currentPassword, user.Salt, user.PasswordHash)) throw Unauthorized();
            ReplacePassword(document, user, password);
            JsonFiles.Write(path, document);
        }
    }

    private static void ReplacePassword(Document document, StoredUser user, string password)
    {
        ValidatePassword(password);
        string salt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        document.Users[document.Users.IndexOf(user)] = user with { Salt = salt, PasswordHash = HashPassword(password, salt) };
        document.Sessions.RemoveAll(s => s.UserId == user.Id);
    }
    private static StoredUser FindUser(Document document, string id) => document.Users.FirstOrDefault(u => u.Id == id)
        ?? throw new GameException("account_not_found", "未找到此账户。", 404);
    private static StoredUser Authenticated(Document document, string token)
    {
        var session = FindSession(document, token) ?? throw Unauthorized();
        var user = document.Users.Single(u => u.Id == session.UserId);
        if (user.Disabled) throw Unauthorized();
        return user;
    }
    private static StoredSession? FindSession(Document document, string token) => ValidHex(token, 64)
        ? document.Sessions.FirstOrDefault(s => s.TokenHash == JsonFiles.Hash(token) && s.ExpiresAt > DateTimeOffset.UtcNow) : null;
    private static void Admin(Document document, string token)
    {
        if (Authenticated(document, token).Id != AdminId) throw Forbidden();
    }
    private static AccountUser View(StoredUser user) => new(user.Id, user.Username, user.Id == AdminId, user.Disabled);
    private static string Username(string value)
    {
        if (value is null) throw new GameException("invalid_username", "请填写用户名。");
        value = value.Trim();
        if (value.Length is < 1 or > 40 || value.Any(c => !char.IsLetterOrDigit(c) && c is not ('-' or '_' or '.')))
            throw new GameException("invalid_username", "用户名应为 1–40 个字母、数字、点、短横线或下划线。");
        return value;
    }
    private static void ValidatePassword(string password)
    {
        if (string.IsNullOrWhiteSpace(password) || password.Length is < 8 or > 128 || password.Any(char.IsControl))
            throw new GameException("invalid_password", "密码应为 8–128 个字符，不能全为空白或包含控制字符。");
    }
    private static string HashPassword(string password, string salt) => Convert.ToHexStringLower(
        Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromHexString(salt), PasswordIterations, HashAlgorithmName.SHA256, 32));
    private static bool Verify(string password, string salt, string expected) => CryptographicOperations.FixedTimeEquals(
        Convert.FromHexString(HashPassword(password, salt)), Convert.FromHexString(expected));
    private static bool ValidHex(string? value, int length) => value?.Length == length && value.All(char.IsAsciiHexDigit);
    private static GameException Unauthorized() => new("account_unauthorized", "用户名、密码或登录会话无效，请重新登录。", 401);
    private static GameException Forbidden() => new("forbidden", "此操作需要管理员账户。", 403);
    private static GameException InvalidStore() => new("invalid_account_store", "账户记录损坏或版本不支持；原文件保留，请检查一致备份。", 409);

    private Document Read()
    {
        Document document;
        try { document = JsonFiles.Read<Document>(path); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException) { throw InvalidStore(); }
        if (document.SchemaVersion != 1 || !ValidHex(document.FingerprintKey, 64) || document.Users is null || document.Sessions is null ||
            document.Users.Any(u => u is null || !Guid.TryParseExact(u.Id, "D", out _) || string.IsNullOrEmpty(u.Username) ||
                u.Username.Length > 40 || u.Username != u.Username.Trim() || u.Username.Any(c => !char.IsLetterOrDigit(c) && c is not ('-' or '_' or '.')) ||
                !ValidHex(u.Salt, 32) || !ValidHex(u.PasswordHash, 64)) ||
            document.Users.Select(u => u.Id).Distinct().Count() != document.Users.Count ||
            document.Users.Select(u => u.Username).Distinct(StringComparer.OrdinalIgnoreCase).Count() != document.Users.Count ||
            document.Users.Count(u => u.Id == AdminId && u.Username == "admin" && !u.Disabled) != 1 ||
            document.Sessions.Any(s => s is null || !ValidHex(s.TokenHash, 64) || s.ExpiresAt == default || !document.Users.Any(u => u.Id == s.UserId)) ||
            document.Sessions.Select(s => s.TokenHash).Distinct().Count() != document.Sessions.Count) throw InvalidStore();
        return document;
    }
}
