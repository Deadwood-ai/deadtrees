import LogoBannerBand from "./LogoBanner";

const trustedByLogos = [
  { alt: "PRIWA", path: "/assets/logos/priwa.svg", url: "https://prima-wald.de/" },
  {
    alt: "Forstliche Versuchs- und Forschungsanstalt Baden-Württemberg",
    path: "/assets/logos/fva.svg",
    url: "https://www.fva-bw.de/",
  },
  { alt: "ForstBW", path: "/assets/logos/forstbw.svg", url: "https://www.forstbw.de/" },
  {
    alt: "Landesbetrieb Wald und Holz NRW",
    path: "/assets/logos/wald-und-holz-nrw.svg",
    url: "https://www.wald-und-holz.nrw.de/",
  },
  {
    alt: "European Commission Joint Research Centre",
    path: "/assets/logos/jrc.svg",
    url: "https://joint-research-centre.ec.europa.eu/",
  },
  {
    alt: "Future Forests Cluster of Excellence",
    path: "/assets/logos/future-forests.png",
    url: "https://www.futureforests.uni-freiburg.de/",
  },
  {
    alt: "Junta de Andalucía",
    path: "/assets/logos/junta-de-andalucia.svg",
    url: "https://www.juntadeandalucia.es/",
  },
];

export default function TrustedBy() {
  return (
    <section className="w-full border-t border-slate-200/50 bg-white py-16 md:py-20" data-testid="trusted-by">
      <p className="m-0 pb-4 text-center text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
        Trusted by
      </p>
      <div className="m-auto max-w-[1640px] px-4 md:px-10">
        <div className="py-4 md:py-6">
          <LogoBannerBand logos={trustedByLogos} title="" compact />
        </div>
      </div>
    </section>
  );
}
