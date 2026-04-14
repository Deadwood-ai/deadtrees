import type { ThemeConfig } from "antd";
import { palette, semanticColors } from "./palette";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary[500],
    colorInfo: palette.secondary[500],
    colorLink: palette.secondary[500],
    colorSuccess: palette.forest[500],
    colorWarning: palette.deadwood[500],
    colorText: semanticColors.textPrimary,
    colorBgBase: semanticColors.surfaceBase,
    colorBgContainer: semanticColors.surfaceRaised,
    colorBorder: semanticColors.borderSubtle,
  },
  components: {
    Button: {
      // Keep primary button shadow neutral (not green-tinted)
      primaryShadow: "0 2px 0 rgba(15, 23, 42, 0.12)",
    },
  },
};

