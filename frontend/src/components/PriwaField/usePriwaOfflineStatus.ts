import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getPriwaServiceWorkerSnapshot,
  subscribePriwaServiceWorker,
} from "../../pwa/priwaServiceWorker";

const getBrowserOnlineState = () =>
  typeof navigator === "undefined" ? true : navigator.onLine;

export const usePriwaOfflineStatus = () => {
  const serviceWorker = useSyncExternalStore(
    subscribePriwaServiceWorker,
    getPriwaServiceWorkerSnapshot,
    getPriwaServiceWorkerSnapshot,
  );
  const [isOnline, setIsOnline] = useState(getBrowserOnlineState);

  useEffect(() => {
    const updateOnlineState = () => {
      setIsOnline(getBrowserOnlineState());
    };

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  return {
    isOnline,
    serviceWorker,
  };
};
