interface IRelatedService {
  name: string;
  description: string;
  url: string;
  logo: string;
  logoAlt: string;
}

const relatedServices: IRelatedService[] = [
  {
    name: "re3data.org",
    description:
      "deadtrees.earth is listed in the Registry of Research Data Repositories.",
    url: "https://www.re3data.org/repository/r3d100014703",
    logo: "/assets/re3data-badge.svg",
    logoAlt:
      "deadtrees.earth in re3data.org, the Registry of Research Data Repositories",
  },
  {
    name: "FreiDATA",
    description:
      "Published datasets get their DOI through the University of Freiburg research data repository.",
    url: "https://freidata.uni-freiburg.de/communities/deadtrees-earth/",
    logo: "/assets/logos/uni-freiburg.png",
    logoAlt: "University of Freiburg, operator of FreiDATA",
  },
  {
    name: "Galaxy Europe",
    description:
      "The Freiburg-run open platform for accessible, reproducible data analysis.",
    url: "https://usegalaxy.eu/",
    logo: "/assets/logos/galaxy-europe.svg",
    logoAlt: "Galaxy Europe",
  },
  {
    name: "Future Forests",
    description:
      "The University of Freiburg Cluster of Excellence on adapting forests to global change.",
    url: "https://uni-freiburg.de/futureforests-en/",
    logo: "/assets/logos/future-forests.png",
    logoAlt: "Future Forests Cluster of Excellence",
  },
];

export default function RelatedServices() {
  return (
    <section
      aria-labelledby="related-services-heading"
      className="mx-auto mb-24 max-w-6xl"
    >
      <h2
        id="related-services-heading"
        className="mb-6 text-center text-sm font-bold uppercase tracking-widest text-gray-400"
      >
        Related services, initiatives and infrastructure
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {relatedServices.map((service) => (
          <a
            key={service.name}
            href={service.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col items-center gap-4 rounded-3xl bg-white p-6 text-center no-underline shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
          >
            <div className="flex h-16 w-full items-center justify-center">
              <img
                src={service.logo}
                alt={service.logoAlt}
                className="max-h-full max-w-[200px] object-contain"
              />
            </div>
            <div>
              <p className="m-0 font-semibold text-gray-900 group-hover:text-[#1B5E35]">
                {service.name}
              </p>
              <p className="m-0 mt-1 text-sm leading-relaxed text-gray-600">
                {service.description}
              </p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
