import { Grid } from "antd";

type DesktopBreakpoint = "md" | "lg";

export const useIsMobile = (
	desktopBreakpoint: DesktopBreakpoint = "md",
): boolean => {
	const screens = Grid.useBreakpoint();
	return !screens[desktopBreakpoint];
};
