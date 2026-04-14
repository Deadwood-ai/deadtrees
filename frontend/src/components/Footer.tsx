import { Layout } from "antd";
import { Link } from "react-router-dom";
import { useLocation } from "react-router-dom";
const { Footer: AntFooter } = Layout;

interface FooterProps {
  className?: string;
}

export default function Footer({ className = "" }: FooterProps) {
  const location = useLocation();
  return (
    <AntFooter style={{ margin: 0, padding: 2 }} className={`bg-slate-100 ${className}`}>
      <div className="mx-auto px-4">
        <div className="relative flex flex-row items-center justify-between md:mx-4">
          {/* Left side - Copyright */}
          <div className="mb-4 md:mb-0">
            {/* <img src="/assets/logo.png" alt="deadtrees.earth" className="h-8" /> */}
            <span className="font-inter text-sm text-gray-600">© 2025 deadtrees.earth</span>
          </div>

          {/* Center - Links */}
          <div className="flex flex-col space-y-2 underline md:flex-row md:space-x-8 md:space-y-0">
            <Link
              to="/impressum"
              onClick={() => window.scrollTo(0, 0)}
              className="font-inter text-sm font-light tracking-wide text-gray-600 hover:text-gray-900"
            >
              Impressum
            </Link>
            <Link
              to="/datenschutzerklaerung"
              onClick={() => window.scrollTo(0, 0)}
              className="font-inter text-sm font-light tracking-wide text-gray-600 underline hover:text-gray-900"
            >
              Datenschutzerklärung
            </Link>
            <Link
              to="/terms-of-service"
              onClick={() => window.scrollTo(0, 0)}
              className="font-inter text-sm font-light tracking-wide text-gray-600 underline hover:text-gray-900"
            >
              Nutzungsbedingungen
            </Link>
          </div>
        </div>
      </div>
    </AntFooter>
  );
}
