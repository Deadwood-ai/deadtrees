import { Button, Drawer, Popover } from "antd";

import PriwaLayerPanel, {
  type PriwaLayerPanelProps,
} from "./PriwaLayerPanel";

function MapLayersIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
    >
      <path d="M9 18.5 3.5 16V5.5L9 8v10.5Z" />
      <path d="m9 8 6-2.5 5.5 2.5v10.5L15 16l-6 2.5" />
      <path d="M15 5.5V16" />
      <path d="M6.2 10.2 9 11.5l3-1.25 3 1.25 2.8-1.2" opacity={0.55} />
    </svg>
  );
}

interface PriwaLayerControlProps {
  isMobile: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  panelProps: PriwaLayerPanelProps;
}

export default function PriwaLayerControl({
  isMobile,
  isOpen,
  onOpenChange,
  panelProps,
}: PriwaLayerControlProps) {
  const button = (
    <Button
      className="pointer-events-auto shadow-md"
      shape="circle"
      size="large"
      icon={<MapLayersIcon />}
      type={isOpen ? "primary" : "default"}
      aria-pressed={isOpen}
      aria-label="Layer auswählen"
      onClick={isMobile ? () => onOpenChange(true) : undefined}
    />
  );

  if (!isMobile) {
    return (
      <Popover
        trigger="click"
        placement="rightTop"
        content={<PriwaLayerPanel {...panelProps} />}
        open={isOpen}
        onOpenChange={onOpenChange}
      >
        {button}
      </Popover>
    );
  }

  return (
    <>
      {button}
      <Drawer
        title="Layer"
        placement="bottom"
        height="82dvh"
        open={isOpen}
        onClose={() => onOpenChange(false)}
        rootClassName="priwa-layer-sheet-root"
        className="md:hidden"
        styles={{
          header: { padding: "12px 16px" },
          body: {
            padding:
              "12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)",
            overflowY: "auto",
          },
        }}
      >
        <PriwaLayerPanel {...panelProps} variant="sheet" />
      </Drawer>
    </>
  );
}
