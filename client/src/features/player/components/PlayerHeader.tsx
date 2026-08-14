export interface PlayerHeaderProps {
  campaignName: string;
  loggingOut: boolean;
  onLogout: () => void;
}

export function PlayerHeader({ campaignName, loggingOut, onLogout }: PlayerHeaderProps) {
  return (
    <header className="workspace__header">
      <span className="workspace__brand">DND AI-DM · Player</span>
      <span className="workspace__campaign-name">{campaignName}</span>
      <button className="workspace__logout" onClick={onLogout} disabled={loggingOut}>
        退出登录
      </button>
    </header>
  );
}
