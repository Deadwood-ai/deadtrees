import { useEffect } from "react";
import { ILabelData } from "../../../types/labels";
import type { LayerSelection } from "../../PolygonEditor";

interface IEditorLike {
  canUndo: boolean;
  selection?: unknown[] | null;
  undo: () => void;
  toggleDraw: () => void;
  cutHoleWithDrawn: () => void;
  deleteSelected: () => void;
  mergeSelected: () => void;
  clipSelected: () => void;
}

interface IAILike {
  isActive: boolean;
  enable: () => void;
  disable: () => void;
}

interface IUseReferenceEditorKeyboardShortcutsArgs {
  editingMode: ILabelData | null;
  selectedPatchId: number | null;
  setLayerSelection: (value: LayerSelection) => void;
  onEditLayer: () => void;
  onDeselect: () => void;
  onSaveEdits: () => void;
  editor: IEditorLike;
  ai: IAILike;
  isTextInputTarget: (target: EventTarget | null) => boolean;
}

export const useReferenceEditorKeyboardShortcuts = ({
  editingMode,
  selectedPatchId,
  setLayerSelection,
  onEditLayer,
  onDeselect,
  onSaveEdits,
  editor,
  ai,
  isTextInputTarget,
}: IUseReferenceEditorKeyboardShortcutsArgs) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return;

      const isEditing = !!editingMode;
      const availableLayers = isEditing
        ? [editingMode === ILabelData.DEADWOOD ? "deadwood" : "forest_cover", "ortho_only"]
        : ["deadwood", "forest_cover", "ortho_only"];

      if (e.key === "1" && availableLayers.includes("ortho_only")) {
        setLayerSelection("ortho_only");
        return;
      }
      if (e.key === "2" && availableLayers.includes("deadwood")) {
        setLayerSelection("deadwood");
        return;
      }
      if (e.key === "3" && availableLayers.includes("forest_cover")) {
        setLayerSelection("forest_cover");
        return;
      }

      if (!isEditing && e.key.toLowerCase() === "e") {
        e.preventDefault();
        onEditLayer();
        return;
      }

      if (e.key === "Escape" && selectedPatchId) {
        onDeselect();
        return;
      }

      if (!isEditing) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (editor.canUndo) editor.undo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSaveEdits();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          if (ai.isActive) ai.disable();
          else ai.enable();
          return;
        case "a":
          e.preventDefault();
          editor.toggleDraw();
          return;
        case "c":
          if (editor.selection && editor.selection.length === 1) {
            e.preventDefault();
            editor.cutHoleWithDrawn();
          }
          return;
        case "d":
          if (editor.selection && editor.selection.length > 0) {
            e.preventDefault();
            editor.deleteSelected();
          }
          return;
        case "g":
          if (editor.selection && editor.selection.length === 2) {
            e.preventDefault();
            editor.mergeSelected();
          }
          return;
        case "x":
          if (editor.selection && editor.selection.length === 2) {
            e.preventDefault();
            editor.clipSelected();
          }
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editingMode, selectedPatchId, setLayerSelection, onEditLayer, onDeselect, onSaveEdits, editor, ai, isTextInputTarget]);
};
