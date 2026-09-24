import { Grid } from "antd";

type DesktopBreakpoint = "md" | "lg";

// antd's breakpoint widths, used until useBreakpoint reports (it returns {} on
// the first render, which would briefly report every screen as mobile).
const DESKTOP_MIN_WIDTH_PX: Record<DesktopBreakpoint, number> = { md: 768, lg: 992 };

const matchesDesktop = (breakpoint: DesktopBreakpoint): boolean =>
	typeof window !== "undefined" &&
	typeof window.matchMedia === "function" &&
	window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH_PX[breakpoint]}px)`).matches;

export const useIsMobile = (
	desktopBreakpoint: DesktopBreakpoint = "md",
): boolean => {
	const screens = Grid.useBreakpoint();
	return !(screens[desktopBreakpoint] ?? matchesDesktop(desktopBreakpoint));
};
