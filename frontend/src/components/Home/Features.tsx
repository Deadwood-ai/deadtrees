const Feature = ({ title, description, iconPath, accent }: { title: string; description: string; iconPath: string; accent?: "green" | "amber" }) => {
  const bg = accent === "amber" ? "bg-amber-500" : "bg-green-800";
  return (
    <div className="mb-4 w-full rounded-md py-8">
      <div className="flex">
        <div className={`mr-8 flex aspect-square h-16 items-center justify-center rounded-lg ${bg}`}>
          <img className="h-8" src={iconPath} alt={title} />
        </div>
        <div className="text-start">
          <p className="m-0 text-2xl font-semibold text-gray-800">{title}</p>
          {/* hide on smaller screens */}
          <p className="m-0 hidden pt-2 text-lg text-gray-600 md:block">{description}</p>
        </div>
      </div>
      {/* hide on large screens */}
      <p className="m-0 pt-4 text-lg text-gray-600 md:hidden">{description}</p>
    </div>
  );
};

const Features = () => {
  return (
    <div className="pt-24 md:pt-48 md:text-center">
      <p className="text-lg font-semibold text-green-800">OUR SERVICES TO THE COMMUNITY</p>
      <p className="m-0 text-4xl font-semibold text-gray-800 md:text-6xl">Revealing tree mortality patterns</p>
      <p className="m-auto max-w-4xl pt-8 text-left text-lg text-gray-600">
        By integrating Earth observation, machine learning, and ground-based data sources, this initiative aims to
        bridge the existing gaps in understanding global tree mortality dynamics, fostering a comprehensive and
        accessible resource for researchers and stakeholders alike.
      </p>
      <div className="pt-12 md:flex md:pt-24">
        <Feature
          title="Open access community effort"
          description="Upload and download your aerial imagery with optional delineations of standing deadwood. 
          Every contributor will be credited and invited to collaborate."
          iconPath="assets/open-access-icon.svg"
        />
        <Feature
          title="Automatic dead tree detection"
          description="Automatic detection (semantic segmentation) of dead trees in uploaded aerial imagery through a generic detection computer vision model."
          iconPath="assets/ai-icon.svg"
        />
      </div>
      <div className="md:flex">
        <Feature
          title="Large-scale tree mortality map"
          description="Embedded visualization and download of extensive spatiotemporal tree mortality products derived from extrapolating standing deadwood using Earth observation data."
          iconPath="assets/maps-icon.svg"
          accent="amber"
        />
        <Feature
          title="Analysis ready training data"
          description="High-resolution aerial imagery of forests worldwide together with delineated standing deadwood which can be used for training your own AI models."
          iconPath="assets/database-icon.svg"
          accent="amber"
        />
      </div>
    </div>
  );
};

export default Features;
