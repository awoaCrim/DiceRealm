namespace DiceRealm.Server.Domain;

// Explicit arena policy: flat 5-foot cells, centre-to-centre segments, including touched
// obstacle edges. No hidden elevation, darkness or three-dimensional geometry is inferred.
public static class CombatGeometry
{
    public static bool Inside(CombatState b, int x, int y) => x >= 0 && y >= 0 && x < b.Width && y < b.Height;
    public static bool Obstacle(CombatState b, int x, int y) => b.Cells.Any(c => c.X == x && c.Y == y &&
        c.Terrain is "blocked" or "half-cover" or "three-quarters-cover");
    public static int Distance(CombatUnit a, CombatUnit z) => Math.Max(Math.Abs(a.X - z.X), Math.Abs(a.Y - z.Y)) * 5;
    public static bool Adjacent(CombatState b, int x, int y, int nx, int ny) =>
        Math.Max(Math.Abs(nx - x), Math.Abs(ny - y)) == 1 && Inside(b, nx, ny) && !Obstacle(b, nx, ny) &&
        (x == nx || y == ny || !Obstacle(b, nx, y) && !Obstacle(b, x, ny));
    public static bool Reach(CombatState b, CombatUnit a, CombatUnit z) => Distance(a, z) == 5 &&
        Adjacent(b, a.X, a.Y, z.X, z.Y) && Cover(b, a, z) != 99;
    public static int Cover(CombatState b, CombatUnit a, CombatUnit z)
    {
        int degree = 0;
        foreach (var cell in b.Cells)
        {
            if (!Crosses(a.X, a.Y, z.X, z.Y, cell.X, cell.Y)) continue;
            degree = Math.Max(degree, cell.Terrain switch { "blocked" => 99, "half-cover" => 2, "three-quarters-cover" => 5, _ => 0 });
        }
        if (degree < 2 && b.Units.Any(u => u.Id != a.Id && u.Id != z.Id && !u.Withdrawn && u.Standard?.Dead != true &&
            Crosses(a.X, a.Y, z.X, z.Y, u.X, u.Y))) degree = 2;
        return degree;
    }
    private static bool Crosses(int ax, int ay, int zx, int zy, int x, int y)
    {
        if (ax == x && ay == y || zx == x && zy == y) return false;
        double first = 0, last = 1;
        bool Clip(double start, double delta, double min, double max)
        {
            if (delta == 0) return start >= min && start <= max;
            double a = (min - start) / delta, z = (max - start) / delta;
            if (a > z) (a, z) = (z, a);
            first = Math.Max(first, a); last = Math.Min(last, z);
            return first <= last;
        }
        return Clip(ax, zx - ax, x - .5, x + .5) && Clip(ay, zy - ay, y - .5, y + .5);
    }
    public static IEnumerable<(int X, int Y)> Steps(CombatState b, CombatUnit u)
    {
        for (int y = u.Y - 1; y <= u.Y + 1; y++)
        for (int x = u.X - 1; x <= u.X + 1; x++)
            if (Adjacent(b, u.X, u.Y, x, y) && !b.Units.Any(z => z.Id != u.Id && !z.Withdrawn && z.Standard?.Dead != true && z.X == x && z.Y == y))
                yield return (x, y);
    }
    public static int StepCost(CombatState b, CombatUnit u, int x, int y) =>
        CombatEngine.StepCost(b, x, y) + (u.Standard!.Conditions.Contains("Prone") ? 5 : 0);
    public static List<(int X, int Y)> Path(CombatState b, CombatUnit u, Func<int, int, bool> goal)
    {
        var start = (u.X, u.Y);
        var distances = new Dictionary<(int, int), int> { [start] = 0 };
        var prior = new Dictionary<(int, int), (int, int)>();
        var queue = new PriorityQueue<(int X, int Y), (int Cost, int Order)>();
        int order = 0;
        queue.Enqueue(start, (0, order++));
        while (queue.TryDequeue(out var cell, out var priority))
        {
            if (priority.Cost != distances[cell]) continue;
            if (goal(cell.X, cell.Y))
            {
                var result = new List<(int, int)>();
                while (cell != start) { result.Add(cell); cell = prior[cell]; }
                result.Reverse(); return result;
            }
            var cursor = new CombatUnit { Id = u.Id, X = cell.X, Y = cell.Y, Standard = u.Standard };
            foreach (var next in Steps(b, cursor))
            {
                int cost = priority.Cost + StepCost(b, u, next.X, next.Y);
                if (distances.TryGetValue(next, out int old) && cost >= old) continue;
                distances[next] = cost; prior[next] = cell; queue.Enqueue(next, (cost, order++));
            }
        }
        return [];
    }
}
