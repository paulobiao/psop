import {
  BellRing,
  Boxes,
  Building2,
  ChevronLeft,
  ChevronRight,
  History,
  KeyRound,
  Menu,
  Network,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import ShieldWave from '../brand/ShieldWave';

export interface NavigationActions {
  alerts: () => void;
  incidents: () => void;
  agents: () => void;
  sites: () => void;
  inventory: () => void;
  sessions: () => void;
  audit: () => void;
  users: () => void;
  notifications: () => void;
}

interface AppNavigationProps {
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  userName: string;
  userEmail: string;
  alertCount: number;
  compact: boolean;
  mobileOpen: boolean;
  onToggleCompact: () => void;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
  actions: NavigationActions;
}

interface NavigationItem {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  count?: number;
}

function NavigationGroup({
  label,
  items,
  onNavigate,
}: {
  label: string;
  items: NavigationItem[];
  onNavigate: (action: () => void) => void;
}) {
  return (
    <section className="app-nav__group" aria-label={label}>
      <span className="app-nav__group-label">{label}</span>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="app-nav__item"
          onClick={() => onNavigate(item.action)}
          title={item.label}
        >
          <span className="app-nav__item-icon">{item.icon}</span>
          <span className="app-nav__item-label">{item.label}</span>
          {item.count !== undefined && item.count > 0 && (
            <span className="app-nav__count">{item.count}</span>
          )}
        </button>
      ))}
    </section>
  );
}

export default function AppNavigation({
  role,
  userName,
  userEmail,
  alertCount,
  compact,
  mobileOpen,
  onToggleCompact,
  onToggleMobile,
  onCloseMobile,
  actions,
}: AppNavigationProps) {
  const operations: NavigationItem[] = [
    { label: 'Alerts', icon: <ShieldAlert size={18} />, action: actions.alerts, count: alertCount },
    { label: 'Incidents', icon: <History size={18} />, action: actions.incidents },
    { label: 'Agents', icon: <Network size={18} />, action: actions.agents },
  ];
  const assets: NavigationItem[] = [
    { label: 'Sites', icon: <Building2 size={18} />, action: actions.sites },
    { label: 'Inventory', icon: <Boxes size={18} />, action: actions.inventory },
  ];
  const administration: NavigationItem[] = [
    { label: 'Users', icon: <Users size={18} />, action: actions.users },
    { label: 'Sessions', icon: <KeyRound size={18} />, action: actions.sessions },
    { label: 'Audit', icon: <History size={18} />, action: actions.audit },
    { label: 'Notifications', icon: <BellRing size={18} />, action: actions.notifications },
  ];

  const navigate = (action: () => void) => {
    action();
    onCloseMobile();
  };

  return (
    <>
      <header className="mobile-app-header">
        <div className="app-nav__brand-mark"><ShieldWave size={22} /></div>
        <strong>PSOP</strong>
        <button type="button" onClick={onToggleMobile} aria-label="Open navigation" aria-expanded={mobileOpen}>
          <Menu size={20} />
        </button>
      </header>

      {mobileOpen && <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation" onClick={onCloseMobile} />}

      <aside className={`app-nav${compact ? ' app-nav--compact' : ''}${mobileOpen ? ' app-nav--mobile-open' : ''}`}>
        <header className="app-nav__header">
          <div className="app-nav__brand-mark"><ShieldWave size={24} /></div>
          <div className="app-nav__brand-copy">
            <strong>PSOP</strong>
            <span>Security observability</span>
          </div>
          <button className="app-nav__mobile-close" type="button" onClick={onCloseMobile} aria-label="Close navigation">
            <X size={19} />
          </button>
        </header>

        <nav className="app-nav__body" aria-label="Application navigation">
          <div className="app-nav__overview" aria-current="page" title="Overview">
            <span className="app-nav__item-icon"><ShieldWave size={19} /></span>
            <span className="app-nav__item-label">Overview</span>
          </div>
          <NavigationGroup label="Operations" items={operations} onNavigate={navigate} />
          <NavigationGroup label="Assets" items={assets} onNavigate={navigate} />
          {role === 'ADMIN' && <NavigationGroup label="Administration" items={administration} onNavigate={navigate} />}
        </nav>

        <footer className="app-nav__footer">
          <div className="app-nav__profile">
            <span>{userName.slice(0, 1).toUpperCase()}</span>
            <div><strong>{userName}</strong><small>{role === 'ADMIN' ? 'Administrator' : role === 'OPERATOR' ? 'Operator' : 'Viewer'}</small><em>{userEmail}</em></div>
          </div>
          <div className="navigation-account-slot" aria-hidden="true" />
          <button className="app-nav__collapse" type="button" onClick={onToggleCompact} aria-label={compact ? 'Expand navigation' : 'Collapse navigation'}>
            {compact ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
            <span>Collapse</span>
          </button>
        </footer>
      </aside>
    </>
  );
}
