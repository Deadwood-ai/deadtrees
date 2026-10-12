const trustedByLogos = [
  { name: "PRIWA", path: "/assets/logos/priwa.svg", url: "https://prima-wald.de/" },
  {
    name: "Forstliche Versuchs- und Forschungsanstalt Baden-Württemberg",
    path: "/assets/logos/fva.svg",
    url: "https://www.fva-bw.de/",
  },
  { name: "ForstBW", path: "/assets/logos/forstbw.svg", url: "https://www.forstbw.de/" },
  {
    name: "Landesbetrieb Wald und Holz NRW",
    path: "/assets/logos/wald-und-holz-nrw.svg",
    url: "https://www.wald-und-holz.nrw.de/",
  },
  {
    name: "European Commission Joint Research Centre",
    path: "/assets/logos/jrc.svg",
    url: "https://joint-research-centre.ec.europa.eu/",
  },
  {
    name: "Future Forests Cluster of Excellence",
    path: "/assets/logos/future-forests.png",
    url: "https://www.futureforests.uni-freiburg.de/",
  },
  {
    name: "Junta de Andalucía",
    path: "/assets/logos/junta-de-andalucia.svg",
    url: "https://www.juntadeandalucia.es/",
  },
];

export default function TrustedBy() {
  return (
    <section className="w-full border-t border-slate-200/50 bg-white py-16 md:py-20" data-testid="trusted-by">
      <div className="m-auto max-w-[1640px] px-4 md:px-10">
        <p className="m-0 pb-8 text-center text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
          Trusted by
        </p>
        <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-x-8 gap-y-8 p-0">
          {trustedByLogos.map((logo) => (
            <li key={logo.name}>
              <a
                href={logo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block transition-transform duration-200 hover:scale-105"
              >
                <img
                  src={logo.path}
                  alt={logo.name}
                  loading="lazy"
                  className="h-10 w-auto max-w-[180px] object-contain opacity-80 grayscale transition-all duration-300 group-hover:opacity-100 group-hover:grayscale-0 md:h-11"
                />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
