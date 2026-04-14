interface LogoBannerProps {
  logos: Array<{
    path?: string;
    text?: string;
    url?: string;
    height?: string;
  }>;
  title: string;
  compact?: boolean;
}

export default function LogoBannerBand({ logos, title, compact }: LogoBannerProps) {
  const logoHeight = compact ? "h-10" : "h-16";

  return (
    <div className={compact ? "py-0" : "py-4 md:py-8"}>
      {title && <p className="text-md mb-8 text-center text-gray-600">{title}</p>}
      <div className="logo-scroll">
        <div className="logo-container">
          {/* First set of logos */}
          {logos.map((logo, index) => (
            <a
              key={index}
              href={logo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="logo-item flex flex-col items-center gap-2 no-underline"
              onClick={(e) => {
                if (!logo.url) {
                  e.preventDefault();
                }
              }}
            >
              <div className="group transition-all duration-200 ease-in-out hover:scale-105">
                <>
                  <img
                    src={logo.path}
                    alt={logo.text || "Partner logo"}
                    className={`${compact ? (logo.height ? "h-14" : logoHeight) : (logo.height || "h-16")} w-full object-contain transition-all duration-300 group-hover:opacity-100 grayscale opacity-90 group-hover:grayscale-0`}
                  />
                  {logo.text && (
                    <p className="mt-2 text-center text-sm text-gray-600 transition-colors duration-200 group-hover:text-blue-600">
                      {logo.text}
                    </p>
                  )}
                </>
              </div>
            </a>
          ))}
          {/* Duplicate set for seamless loop */}
          {logos.map((logo, index) => (
            <a
              key={`dup-${index}`}
              href={logo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="logo-item flex flex-col items-center gap-2 no-underline"
              onClick={(e) => {
                if (!logo.url) {
                  e.preventDefault();
                }
              }}
            >
              <div className="group transition-all duration-200 ease-in-out hover:scale-105">
                <>
                  <img
                    src={logo.path}
                    alt={logo.text || "Partner logo"}
                    className={`${compact ? (logo.height ? "h-14" : logoHeight) : (logo.height || "h-16")} w-full object-contain transition-all duration-300 group-hover:opacity-100 grayscale opacity-90 group-hover:grayscale-0`}
                  />
                  {logo.text && (
                    <p className="mt-2 text-center text-sm text-gray-600 transition-colors duration-200 group-hover:text-blue-600">
                      {logo.text}
                    </p>
                  )}
                </>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
