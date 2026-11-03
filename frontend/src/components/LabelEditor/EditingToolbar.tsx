import { EditorToolbar } from "../PolygonEditor";
import type { useDatasetEditing } from "../../hooks/useDatasetEditing";

interface EditingToolbarProps {
  editing: ReturnType<typeof useDatasetEditing>;
}

/** The editing-mode toolbar of the label editor, wired to one editing session. */
export default function EditingToolbar({ editing }: EditingToolbarProps) {
  const { editor, ai, areaTools, editingLayerType } = editing;
  const layer = editingLayerType ?? "deadwood";
  return (
    <EditorToolbar
      type={layer}
      isDrawing={editor.isDrawing}
      hasSelection={editor.selection.length > 0}
      selectionCount={editor.selection.length}
      isAIActive={ai.isActive}
      isAIProcessing={ai.isProcessing}
      onToggleDraw={() => editor.toggleDraw()}
      onCutHole={editor.cutHoleWithDrawn}
      onMerge={editor.mergeSelected}
      onClip={editor.clipSelected}
      onToggleAI={() => (ai.isActive ? ai.disable() : ai.enable())}
      aiMode={ai.mode}
      onAIModeChange={ai.setMode}
      areaTools={{
        layer,
        action: areaTools.action,
        preview: areaTools.preview,
        onStart: (action) => areaTools.start(action, editing.findPrompt),
        findPrompt: editing.findPrompt,
        onFindPromptChange: editing.setFindPrompt,
        onAcceptPreview: areaTools.acceptPreview,
        onDiscardPreview: areaTools.discardPreview,
        canCopy: editor.selection.length > 0,
        onCopyToOtherLayer: editing.copySelectionToOtherLayer,
        disabled: ai.isActive || ai.isProcessing || editing.isSaving,
      }}
      onDeleteSelected={editor.deleteSelected}
      onUndo={editor.undo}
      canUndo={editor.canUndo}
      onSave={editing.handleSaveEdits}
      onCancel={editing.handleCancelEditing}
      position="top-right"
      title={`Editing ${layer === "deadwood" ? "deadwood cover" : "tree cover"}`}
    />
  );
}
