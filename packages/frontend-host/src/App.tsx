import { useEffect, useState } from 'preact/hooks';
import { Route, Switch, useLocation } from 'wouter';
import { getMountsForTarget, MountPoint, useSetting } from '@its/sdk-react';

import { Home } from './Home';
import { MobileNav } from './MobileNav';
import { NavRail } from './NavRail';
import { Settings } from './Settings';
import { TabContent } from './TabContent';

// Syncs documentElement.dataset.theme with the lightMode setting at runtime.
// The initial value is set in main.tsx before mount to avoid a flash; this
// only handles in-session changes.
function ThemeManager() {
  const [lightMode] = useSetting<boolean>('global', 'lightMode', false);
  useEffect(() => {
    if (lightMode) {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
  }, [lightMode]);
  return null;
}

interface Tab {
  pluginId: string;
  route: string;
  component: string;
  title: string;
}

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [location] = useLocation();

  useEffect(() => {
    getMountsForTarget('tab').then((mounts) => {
      setTabs(
        mounts.flatMap(({ pluginId, mount }) =>
          mount.route && mount.title
            ? [{
                pluginId,
                route: mount.route,
                component: mount.component,
                title: mount.title,
              }]
            : [],
        ),
      );
    });
  }, []);

  // Sync the document title to the active route so popped-out windows are
  // distinguishable in the OS tab list.
  const activeTab = tabs.find((t) => t.route === location);
  useEffect(() => {
    document.title = activeTab ? `ITS - ${activeTab.title}` : 'ITS';
  }, [activeTab]);

  return (
    <>
      <ThemeManager />
      <MobileNav />
      {/* `overlay` mount slot: route-independent plugin surfaces (command
          palette, notification stack, status banner). Any number of plugins
          target it, layered at App root by z-index. */}
      <MountPoint target="overlay" />
      {/* Nav rail is position:fixed and drives --its-rail-width; kept outside
          .its-content so it isn't offset by its own gutter. */}
      <NavRail />
      {/* padding-left: var(--its-rail-width) (theme.css) clears flow content. */}
      <div class="its-content">
        <Switch>
          <Route path="/" component={Home} />
          {/* Registered ahead of plugin routes so a tab mount can't shadow it. */}
          <Route path="/settings" component={Settings} />
          {tabs.map((t) => (
            <Route key={t.route} path={t.route}>
              <TabContent pluginId={t.pluginId} componentName={t.component} />
            </Route>
          ))}
          <Route>
            <div style={notFoundStyle}>
              <h2 style={{ margin: 0, fontSize: '1.2rem' }}>404</h2>
              <p style={{ color: 'var(--text-dim)', marginTop: '0.4rem' }}>
                No route matched.
              </p>
            </div>
          </Route>
        </Switch>
      </div>
    </>
  );
}

const notFoundStyle = {
  padding: '4rem 2rem',
  textAlign: 'center' as const,
  color: 'var(--text)',
  fontFamily: 'var(--sans)',
};
