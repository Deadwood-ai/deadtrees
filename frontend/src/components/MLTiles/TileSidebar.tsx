import { Button, Card, Divider, Space, Tag } from "antd";
import { IMLTile } from "../../types/mlTiles";
import { useDeleteMLTile, useGenerateNestedTiles, useUpdateTileStatus } from "../../hooks/useMLTiles";

interface Props {
  tile: IMLTile | null;
  onClose: () => void;
}

export default function TileSidebar({ tile, onClose }: Props) {
  const { mutate: updateStatus, isPending: updating } = useUpdateTileStatus();
  const { mutate: deleteTile, isPending: deleting } = useDeleteMLTile();
  const { mutate: generateChildren, isPending: generating } = useGenerateNestedTiles();

  if (!tile) {
    return (
      <div className="h-full w-96 border-l bg-white p-4">
        <div className="text-sm text-gray-500">Select a tile to view options</div>
      </div>
    );
  }

  const handleSet = (status: IMLTile["status"]) => {
    updateStatus({ tileId: tile.id, status });
  };

  const handleDelete = () => {
    deleteTile({ tileId: tile.id, datasetId: tile.dataset_id });
    onClose();
  };

  const canGenerateChildren = tile.resolution_cm === 20 || tile.resolution_cm === 10;

  return (
    <div className="h-full w-96 border-l bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">Tile {tile.tile_index}</div>
        <Button type="text" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mb-2 text-xs text-gray-500">Resolution</div>
      <Tag color="blue">{tile.resolution_cm} cm</Tag>

      <Divider className="my-4" />

      <Card size="small" title="QA Status">
        <Space>
          <Button
            onClick={() => handleSet("good")}
            loading={updating}
            type={tile.status === "good" ? "primary" : "default"}
          >
            Good (G)
          </Button>
          <Button
            onClick={() => handleSet("bad")}
            loading={updating}
            type={tile.status === "bad" ? "primary" : "default"}
          >
            Bad (B)
          </Button>
          <Button
            onClick={() => handleSet("pending")}
            loading={updating}
            type={tile.status === "pending" ? "primary" : "default"}
          >
            Pending
          </Button>
        </Space>
      </Card>

      <Divider className="my-4" />

      <Card size="small" title="Generate Nested Tiles">
        <Space direction="vertical">
          <div className="text-xs text-gray-500">Create 2x2 children from this tile</div>
          <Button disabled={!canGenerateChildren} onClick={() => generateChildren(tile)} loading={generating}>
            Generate {tile.resolution_cm === 20 ? "10cm" : "5cm"} children
          </Button>
        </Space>
      </Card>

      <Divider className="my-4" />

      <Card size="small" title="Danger zone" styles={{ body: { paddingTop: 8 } }}>
        <Button danger onClick={handleDelete} loading={deleting}>
          Delete tile
        </Button>
      </Card>
    </div>
  );
}
