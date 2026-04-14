declare module "kompas" {
  interface KompasTracker {
    watch(): KompasTracker;
    clear(): KompasTracker;
    on(eventName: "heading", callback: (heading: number) => void): KompasTracker;
  }

  export default function createKompas(options?: { calculate?: boolean }): KompasTracker;
}
