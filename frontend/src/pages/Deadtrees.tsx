import DeadtreesMap from "../components/DeadwoodMap/DeadtreesMap";

const Deadtrees = () => {
  return (
    <div className="h-full w-full" data-testid="deadtrees-map-page">
      <h1 className="sr-only">Sentinel-2 tree cover and deadwood map of Europe</h1>
      <DeadtreesMap />
    </div>
  );
};

export default Deadtrees;
