import { useEffect, useState } from 'react';
import { HomeView, VIEW_PATHS, homeViewFromPath } from '../lib/gameUi';

export function useHomeView() {
  const [homeView, setHomeViewState] = useState<HomeView>(() => homeViewFromPath(window.location.pathname));

  function setHomeView(nextView: HomeView): void {
    setHomeViewState(nextView);
    const nextPath = VIEW_PATHS[nextView];
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view: nextView }, '', nextPath);
    }
  }

  useEffect(() => {
    const onPopState = () => setHomeViewState(homeViewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return { homeView, setHomeView };
}
