import type { IBenchmarkProduct, IBenchmarkSite } from "./types";
import { orderedBenchmarkProducts } from "./benchmarkData";
import { PRODUCT_REFERENCES } from "./productReferences";
interface BenchmarkMethodsProps {
  site: IBenchmarkSite;
  products: IBenchmarkProduct[];
}
export default function BenchmarkMethods({
  site,
  products,
}: BenchmarkMethodsProps) {
  return (
    <details className="db-methods">
      <summary>
        Methods, source definitions and limitations
        <span aria-hidden="true">+</span>
      </summary>
      <div>
        <h3>Imagery sources and licences</h3>
        <p>
          This benchmark presents imagery for non-commercial scientific research
          and comparison of forest-disturbance products.
        </p>
        <p>
          Open drone imagery is linked to its original{" "}
          <a
            href={site.datasetUrl || "https://deadtrees.earth/"}
            target="_blank"
            rel="noreferrer"
          >
            deadtrees.earth dataset submission
          </a>
          . Reuse follows the licence and contributor attribution shown on each
          record, under the platform’s{" "}
          <a
            href="https://deadtrees.earth/terms-of-service"
            target="_blank"
            rel="noreferrer"
          >
            licensing terms
          </a>
          . Public drone imagery is normally licensed under{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY 4.0
          </a>
          ; the individual dataset’s stated licence takes precedence.
        </p>
        <p>
          Planet context imagery was accessed through Planet’s Education and
          Research programme. Citation: Planet Team (2026). Planet Application
          Program Interface: In Space for Life on Earth. San Francisco, CA.{" "}
          <a href="https://api.planet.com" target="_blank" rel="noreferrer">
            Planet API
          </a>
          . The displayed RGB previews remain subject to Planet’s{" "}
          <a
            href="https://support.planet.com/hc/en-us/articles/22540409084701-Dataset-Sharing-Guidelines-for-the-Education-and-Research-Basic-Program"
            target="_blank"
            rel="noreferrer"
          >
            imagery-sharing terms
          </a>
          .
        </p>
        <p>
          Google imagery source: Google Earth historical imagery. Credit: Google
          and contributing imagery providers, such as Maxar Technologies
          (providers vary by image). Reuse is governed by{" "}
          <a
            href="https://about.google/brand-resource-center/products-and-services/geo-guidelines/"
            target="_blank"
            rel="noreferrer"
          >
            Google’s Geo Guidelines
          </a>
          . These third-party images are not covered by the drone datasets’ open
          licence.
        </p>
        <p>
          Esri context imagery: © 2026 Esri and its licensors. All rights
          reserved. Contributing imagery providers vary by location and image;
          supplied image-specific credits are retained where available. Reuse is
          subject to Esri’s{" "}
          <a
            href="https://doc.arcgis.com/en/arcgis-online/reference/static-maps.htm"
            target="_blank"
            rel="noreferrer"
          >
            terms for static maps
          </a>
          . These images are not covered by the drone datasets’ open licence.
        </p>
        <h3>Spatial reference and predictions</h3>
        <p>
          The displayed binary reference and predictions are aligned to the
          drone orthomosaic extent in UTM. The saved evaluation grid and its
          metadata are retained separately. Display resampling does not increase
          the native resolution of satellite products. Saved evaluations do not
          demonstrate full geographic or temporal product coverage.
        </p>
        <h3>Products considered</h3>
        <p>
          Products appear in a fixed order, starting with deadtrees.earth;
          comparison cards show products with supplied raster values for the
          selected site. The order does not indicate performance.
        </p>
        <dl>
          {orderedBenchmarkProducts(products).map((product) => (
            <div key={product.id}>
              <dt>
                <a
                  href={PRODUCT_REFERENCES[product.id]?.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {product.name} —{" "}
                  {PRODUCT_REFERENCES[product.id]?.fullName || product.name} ↗
                </a>
              </dt>
              <dd>
                {PRODUCT_REFERENCES[product.id]?.description ||
                  product.definition}
              </dd>
            </div>
          ))}
        </dl>
        <p>
          Drone imagery, reference polygons and temporal context come from
          Results_plots_v10. Satellite overlays use the saved binary predictions
          in 6-Validation/tmp_residuals_0.25_all_NO_mask_v5. Only the combined
          preceding-year and flight-year products (*_by_pred_res.tif) are shown:
          disturbance in b OR y. The following year (a), including bya products,
          is excluded. DTE uses dt_fc_dw_comb_by, combining tree-cover loss and
          standing deadwood as supplied in the saved evaluation; no threshold is
          reapplied to the continuous v10 change bands. Precision, recall and F1
          remain NA. Missing products are not interpreted as zero disturbance.
        </p>
        <h3>Temporal evidence</h3>
        <p>
          Planet GCC is an RGB greenness proxy, G / (R + G + B), averaged per
          valid native pixel within the drone orthomosaic footprint. It is not
          NDVI, and no supplied cloud mask is applied. Planet records are
          monthly and quarterly composites; their periods can overlap. Sentinel
          index aggregation footprints may differ from the displayed drone
          extent. Dated imagery provides context, rather than an exact
          disturbance date.
        </p>
        <h3>Data provenance</h3>
        <p>
          Imagery: {site.provenance.imageryVersion}. Evaluation:{" "}
          {site.provenance.evaluationVersion}. Window: {site.provenance.window}.
          Classification: supplied binary masks. CRS: {site.crs}.
        </p>
        {site.notes?.length > 0 && (
          <ul>
            {site.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
        {site.datasetUrl && (
          <a href={site.datasetUrl} target="_blank" rel="noreferrer">
            View the drone dataset and attribution ↗
          </a>
        )}
      </div>
    </details>
  );
}
