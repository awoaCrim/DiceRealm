using System.Security.Cryptography;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

internal static class RoomCredentials
{
    private const int Iterations = 600_000;
    private static readonly byte[] DummySalt = new byte[16], DummyHash = new byte[32];
    internal static bool ValidNumber(string? number) => number is { Length: 8 } && number.All(c => c is >= '0' and <= '9');
    internal static void ValidatePassword([System.Diagnostics.CodeAnalysis.NotNull] string? password)
    {
        if (password is null || password.Length is < 8 or > 128 || string.IsNullOrWhiteSpace(password) || password.Any(char.IsControl))
            throw new GameException("invalid_room_password", "房间密码须为 8–128 个字符，不能全为空白或包含控制字符。", 400);
    }
    internal static RoomSettings Create(string number, string password)
    {
        ValidatePassword(password);
        var salt = RandomNumberGenerator.GetBytes(16);
        return new(number, true, Convert.ToHexStringLower(salt), Convert.ToHexStringLower(Derive(password, salt)));
    }
    internal static bool Verify(string password, RoomSettings? room)
    {
        byte[] salt = room is null ? DummySalt : Convert.FromHexString(room.Salt);
        byte[] expected = room is null ? DummyHash : Convert.FromHexString(room.PasswordHash);
        if (salt.Length != 16 || expected.Length != 32) throw new InvalidDataException("Invalid room credential record.");
        bool matches = CryptographicOperations.FixedTimeEquals(Derive(password, salt), expected);
        return room is not null && room.Enabled && matches;
    }
    private static byte[] Derive(string password, byte[] salt) => Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
    internal static GameException Denied() => new("room_access_denied", "房间号或密码不正确，或房间已关闭加入。", 401);
}
