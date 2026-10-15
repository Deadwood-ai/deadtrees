import { Popover } from "antd";
import { PRODUCT_REFERENCES } from "./productReferences";
import type { IBenchmarkProduct } from "./types";

export default function BenchmarkProductHeading({
  product,
}: {
  product: IBenchmarkProduct;
}) {
  const reference = PRODUCT_REFERENCES[product.id];
  if (!reference) return <h3>{product.name}</h3>;
  return (
    <div className="db-product-inline-heading">
      <h3>
        <Popover
          trigger={["hover", "focus", "click"]}
          title={reference.fullName}
          content={
            <div className="db-product-popover">
              <p>{product.definition}</p>
              <a href={reference.url} target="_blank" rel="noreferrer">
                {reference.linkLabel || "Product website"} ↗
              </a>
            </div>
          }
        >
          <button
            className="db-product-info"
            aria-label={`About ${product.name}: ${reference.fullName}`}
          >
            <i style={{ background: product.color }} aria-hidden="true" />
            {product.name}
            <span aria-hidden="true">ⓘ</span>
          </button>
        </Popover>
      </h3>
    </div>
  );
}
