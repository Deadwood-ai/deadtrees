const DOI_BADGES = [
  "10.60493/4mn6a-8zx75",
  "10.60493/ftw67-pnd16",
  "10.60493/nzzsq-m4a90",
  "10.60493/0gdk6-rwg98",
];

const ADDING_AI_VIDEO_URL = "https://data2.deadtrees.earth/assets/v1/videos/adding-ai.mp4";
const SATELLITE_ANALYSIS_VIDEO_URL = "https://data2.deadtrees.earth/assets/v1/videos/satellite-analysis.mp4";

const PlatformFeatures = () => {
  return (
    <section className="w-full bg-white py-24 md:py-32">
      <div className="m-auto flex w-full max-w-6xl flex-col">
        <div className="mb-16 text-center px-4">
        <h2 className="m-0 text-4xl font-bold tracking-tight text-gray-900 md:text-5xl">Additional features</h2>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
          Built from the ground up for researchers. Share your data, get credited, and access global-scale forest mortality products.
        </p>
      </div>

      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-4 md:grid-cols-2 md:grid-flow-row-dense">
        
        {/* Labeling Card - Span 2 */}
        <div className="group relative flex flex-col justify-between overflow-hidden rounded-3xl bg-gray-50 md:col-span-2 md:flex-row md:items-center transition-all hover:bg-gray-100/80">
          <div className="p-8 md:w-1/2 md:p-10">
            <div className="mb-4 inline-flex items-center rounded-full bg-emerald-100/50 px-3 py-1.5 text-xs font-semibold tracking-wide text-emerald-700">
              QUALITY CONTROL
            </div>
            <h3 className="mb-3 text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">Community labeling</h3>
            <p className="text-base leading-relaxed text-gray-600">
              Review predictions, add missing polygons, and correct deadwood labels directly in the browser to improve training data quality.
            </p>
          </div>
          <div className="relative w-full px-8 pb-8 md:w-1/2 md:p-10 md:pl-0">
            <div className="overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5">
              <video src={ADDING_AI_VIDEO_URL} autoPlay loop muted playsInline preload="metadata" className="w-full object-cover" />
            </div>
          </div>
        </div>

        {/* Raw Imagery Card - Span 1 */}
        <div className="group relative flex flex-col justify-between overflow-hidden rounded-3xl bg-gray-50 md:col-span-1 transition-all hover:bg-gray-100/80">
          <div className="p-8 md:p-10">
            <div className="mb-4 inline-flex items-center rounded-full bg-amber-100/50 px-3 py-1.5 text-xs font-semibold tracking-wide text-amber-700">
              INGESTION
            </div>
            <h3 className="mb-3 text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">From raw to georeferenced drone imagery</h3>
            <p className="text-base leading-relaxed text-gray-600">
              Upload orthomosaics or simply raw .jpeg files. Our OpenDroneMap pipeline automatically generates analysis-ready orthophotos for free.
            </p>
          </div>
          
          {/* Visual */}
          <div className="px-8 pb-8 md:px-10 md:pb-10">
            <div className="flex flex-col gap-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
               <div className="flex items-center gap-3">
                 <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-50 text-gray-400 ring-1 ring-inset ring-gray-200">
                   <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                 </div>
                 <div>
                   <div className="text-sm font-semibold text-gray-900">raw_images.zip</div>
                   <div className="text-xs font-medium text-gray-500">2.4 GB</div>
                 </div>
               </div>
               <div className="ml-5 border-l-2 border-dashed border-gray-200 py-2.5 pl-5">
                 <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600">ODM Processing</div>
               </div>
               <div className="flex items-center gap-3">
                 <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200">
                   <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                 </div>
                 <div>
                   <div className="text-sm font-semibold text-gray-900">orthomosaic.tif</div>
                   <div className="text-xs font-medium text-emerald-600">Ready for AI</div>
                 </div>
               </div>
            </div>
          </div>
        </div>

        {/* DOI Card - Span 1 */}
        <div className="group relative flex flex-col justify-between overflow-hidden rounded-3xl bg-gray-50 md:col-span-1 transition-all hover:bg-gray-100/80">
          <div className="p-8 md:p-10">
            <div className="mb-4 inline-flex items-center rounded-full bg-indigo-100/50 px-3 py-1.5 text-xs font-semibold tracking-wide text-indigo-700">
              PUBLISHING
            </div>
            <h3 className="mb-3 text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">Mint a persistent DOI</h3>
            <p className="text-base leading-relaxed text-gray-600">
              Archive your drone datasets for long-term reuse and cite them in publications. Make your contributions discoverable and creditable.
            </p>
          </div>
          <div className="relative flex flex-col gap-3 px-8 pb-8 md:px-10 md:pb-10">
            {DOI_BADGES.map((doi, index) => (
              <a
                key={doi}
                href={`https://doi.org/${doi}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open DOI ${doi}`}
                className={`block w-fit rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5 transition-all hover:scale-[1.02] ${index > 0 ? "-mt-1" : ""}`}
                style={{
                  opacity: [1, 0.8, 0.5, 0.25][index] ?? 1,
                  zIndex: [40, 30, 20, 10][index] ?? 1,
                }}
              >
                <img src={`https://freidata.uni-freiburg.de/badge/DOI/${doi}.svg`} alt="FreiDATA DOI badge" className="h-6" />
              </a>
            ))}
          </div>
        </div>

        {/* Large Satellite Card - Span 2 */}
        <div className="group relative flex flex-col justify-between overflow-hidden rounded-3xl bg-gray-50 md:col-span-2 md:flex-row md:items-center transition-all hover:bg-gray-100/80">
          <div className="p-8 md:w-1/2 md:p-10">
            <div className="mb-4 inline-flex items-center rounded-full bg-blue-100/50 px-3 py-1.5 text-xs font-semibold tracking-wide text-blue-700">
              SATELLITE PRODUCTS
            </div>
            <h3 className="mb-3 text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">AI-ready maps & analysis</h3>
            <p className="max-w-md text-base leading-relaxed text-gray-600">
              Explore forest mortality products at European scale with interactive analysis tools that reveal year-by-year trends and regional dynamics.
            </p>
          </div>
          <div className="relative mt-2 w-full px-8 pb-8 md:mt-0 md:w-1/2 md:p-10 md:pl-0">
            <div className="overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5">
              <video src={SATELLITE_ANALYSIS_VIDEO_URL} autoPlay loop muted playsInline preload="metadata" className="w-full object-cover" />
            </div>
          </div>
        </div>

      </div>
      </div>
    </section>
  );
};

export default PlatformFeatures;
