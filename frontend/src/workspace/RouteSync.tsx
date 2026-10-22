// Brings every router navigation into the active tab (DESIGN §6.38). A layout effect, so the
// panes show the new route before the browser paints.
import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { routeOf } from './model';
import { routerNavigated } from './store';

export function RouteSync() {
  const location = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    routerNavigated(routeOf(location), type);
  }, [location, type]);
  return null;
}
