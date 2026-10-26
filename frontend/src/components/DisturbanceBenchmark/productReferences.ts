// Product landing pages, checked 9 October 2026. These identify the product
// families; evaluation versions and thresholds remain in the source metadata.
export const PRODUCT_REFERENCES: Record<
  string,
  {
    fullName: string;
    description: string;
    url: string;
    linkLabel?: string;
  }
> = {
  da: {
    fullName: "OPERA Surface Disturbance Alert",
    description:
      "Detects vegetation disturbance from Harmonized Landsat and Sentinel-2 observations.",
    url: "https://www.jpl.nasa.gov/go/opera/products/dist-product-suite/",
  },
  dte: {
    fullName: "deadtrees.earth satellite product",
    description:
      "Combines tree-cover loss and standing deadwood in the supplied binary b+y classification.",
    url: "https://deadtrees.earth/releases/sentinel-2-satellite-map",
  },
  echosat: {
    fullName: "Estimating Canopy Height Over Space and Time",
    description:
      "Provides annual canopy-height estimates, whose declines are used here to identify disturbance.",
    url: "https://janpauls.org/projects/echosat/",
  },
  efda: {
    fullName: "European Forest Disturbance Atlas",
    description:
      "Maps annual forest disturbances across Europe using the Landsat archive.",
    url: "https://essd.copernicus.org/articles/17/2373/2025/",
    linkLabel: "Dataset publication",
  },
  gfc: {
    fullName: "Global Forest Change",
    description: "Maps annual tree-cover loss globally from Landsat imagery.",
    url: "https://glad.earthengine.app/view/global-forest-change",
  },
  lam: {
    fullName: "Latin America Woody Vegetation Structure and Change",
    description:
      "Maps woody vegetation structure and changes, including removal and degradation, across Latin America.",
    url: "https://zenodo.org/records/14231362",
    linkLabel: "Dataset and documentation",
  },
  radd: {
    fullName: "Radar for Detecting Deforestation",
    description:
      "Uses Sentinel-1 radar observations to detect forest disturbances in tropical forests.",
    url: "https://www.wur.nl/en/research/products-services/radd-forest-disturbance-alert",
  },
  tc: {
    fullName: "Copernicus Tree Cover Density",
    description:
      "Maps tree-cover density across Europe, with decreases used here to identify disturbance.",
    url: "https://land.copernicus.eu/en/products/high-resolution-layer-forests-and-tree-cover?tab=tree_cover_density",
  },
  tmf: {
    fullName: "Tropical Moist Forest",
    description:
      "Tracks degradation, deforestation and recovery of tropical moist forests using the Landsat archive.",
    url: "https://forobs.jrc.ec.europa.eu/TMF/",
  },
};
