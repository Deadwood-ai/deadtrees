import { Grid } from "antd";

export const useIsMobile = (): boolean => {
	const screens = Grid.useBreakpoint();
	return !screens.md;
};
