/** Papers the site asks users to cite, shared by the About page and the places that show the
 * model's output. */

export interface ICitation {
  /** the paper's page */
  url: string;
  /** a short link label, e.g. "Mosig et al., 2026 (EarthArXiv preprint)" */
  short: string;
  bibtex: string;
  apa: string;
}

/** AerialStamp, the acquisition-date model (processing stage doy_estimation_v1). */
export const AERIALSTAMP_CITATION: ICitation = {
  url: "https://eartharxiv.org/repository/view/15721/",
  short: "Mosig et al., 2026 (EarthArXiv preprint)",
  bibtex: String.raw`@article{mosig2026aerialstamp,
  title={AerialStamp: dating aerial orthophotos from visual cues and Sentinel-2 time series},
  author={Clemens Mosig and David Montero Loaiza and Miguel Mahecha and Janusch Vajna-Jehle and Teja Kattenborn},
  year={2026},
  publisher={EarthArXiv},
  doi={10.31223/X5SZ4Q},
  url={https://eartharxiv.org/repository/view/15721/}
}`,
  apa: "Mosig, C., Montero Loaiza, D., Mahecha, M., Vajna-Jehle, J., & Kattenborn, T. (2026). AerialStamp: dating aerial orthophotos from visual cues and Sentinel-2 time series. EarthArXiv. https://doi.org/10.31223/X5SZ4Q",
};

/** The AerialStamp code. */
export const AERIALSTAMP_REPO = "https://github.com/cmosig/aerialstamp";
