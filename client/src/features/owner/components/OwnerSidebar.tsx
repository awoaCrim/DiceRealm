import { NavLink } from 'react-router-dom';

const OWNER_NAV = [
  { to: 'turn', label: '回合与 AI 运行' },
  { to: 'characters', label: '角色审核' },
  { to: 'world', label: '世界' },
  { to: 'combat', label: '战斗' },
  { to: 'archives', label: '存档' },
  { to: 'rules', label: '规则资料' },
  { to: 'ai-provider', label: 'AI 接口' },
  { to: 'ai-logs', label: 'AI 日志' },
] as const;

export function OwnerSidebar({ campaignId }: { campaignId: string }) {
  return (
    <nav className="workspace__sidebar" aria-label="Owner 导航">
      <ul>
        {OWNER_NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={`/campaigns/${encodeURIComponent(campaignId)}/owner/${item.to}`}
              className={({ isActive }) => (isActive ? 'workspace__link is-active' : 'workspace__link')}
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
