import type { EventViewer } from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';

export interface SessionAuthorityBinding {
  internalSessionId: string;
  userId: string;
  authRevision: number;
  revokeEpoch: number;
  campaignId: string;
  viewer: EventViewer;
}

interface AuthorityRow {
  user_id: string;
  captured_auth_revision: number;
  user_auth_revision: number;
  user_status: 'active' | 'disabled';
  revoke_epoch: number;
  revoked_at: string | null;
  absolute_expires_at: string;
  idle_expires_at: string;
}

/** Side-effect-free authoritative checker for an already-bound SSE request. */
export class SessionAuthority {
  constructor(
    private readonly database: DatabasePort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async isCurrent(binding: SessionAuthorityBinding): Promise<boolean> {
    try {
      return await this.database.readCommitted(async (reader) => {
        const rows = await reader.query<AuthorityRow>(
          `SELECT s.user_id, s.captured_auth_revision,
                  u.auth_revision AS user_auth_revision, u.status AS user_status,
                  s.revoke_epoch, s.revoked_at, s.absolute_expires_at, s.idle_expires_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.id = ?
              AND s.token_digest IS NOT NULL
              AND s.csrf_digest IS NOT NULL
              AND s.captured_auth_revision IS NOT NULL
              AND s.absolute_expires_at IS NOT NULL
              AND s.idle_expires_at IS NOT NULL
              AND s.last_seen_at IS NOT NULL`,
          [binding.internalSessionId],
        );
        const row = rows[0];
        if (!row) return false;
        const now = this.clock().getTime();
        return row.user_id === binding.userId
          && row.user_status === 'active'
          && row.revoked_at === null
          && row.captured_auth_revision === binding.authRevision
          && row.user_auth_revision === binding.authRevision
          && row.revoke_epoch === binding.revokeEpoch
          && !isExpired(row.absolute_expires_at, now)
          && !isExpired(row.idle_expires_at, now);
      });
    } catch {
      return false;
    }
  }
}

function isExpired(value: string, now: number): boolean {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || parsed <= now;
}
