using Npgsql;

namespace Inventory.Api.Common;

/// <summary>Creates the <c>inventory</c> database and schema on startup (idempotent).</summary>
public static class Database
{
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS stock (
            event_id uuid PRIMARY KEY,
            total_tickets int NOT NULL,
            available int NOT NULL,
            CONSTRAINT stock_available_range CHECK (0 <= available AND available <= total_tickets)
        );
        CREATE TABLE IF NOT EXISTS reservations (
            order_id uuid PRIMARY KEY,
            event_id uuid NOT NULL REFERENCES stock (event_id),
            quantity int NOT NULL CHECK (quantity > 0),
            status text NOT NULL CHECK (status IN ('active', 'released')),
            created_at timestamptz NOT NULL DEFAULT now(),
            released_at timestamptz NULL
        );
        """;

    public static async Task MigrateAsync(string connectionString)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        var database = builder.Database!;

        builder.Database = "postgres";
        await using (var admin = new NpgsqlConnection(builder.ConnectionString))
        {
            await admin.OpenAsync();
            await using var exists = new NpgsqlCommand("SELECT 1 FROM pg_database WHERE datname = @n", admin);
            exists.Parameters.AddWithValue("n", database);
            if (await exists.ExecuteScalarAsync() is null)
            {
                await using var create = new NpgsqlCommand($"CREATE DATABASE \"{database.Replace("\"", "\"\"")}\"", admin);
                try { await create.ExecuteNonQueryAsync(); }
                catch (PostgresException e) when (e.SqlState is "42P04" or "23505") { } // created concurrently
            }
        }

        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using var lockCmd = new NpgsqlCommand("SELECT pg_advisory_xact_lock(727001)", conn, tx);
        await lockCmd.ExecuteNonQueryAsync();
        await using var ddl = new NpgsqlCommand(Schema, conn, tx);
        await ddl.ExecuteNonQueryAsync();
        await tx.CommitAsync();
    }
}
