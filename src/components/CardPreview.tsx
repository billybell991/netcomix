export interface PreviewItem {
  title: string;
  coverSrc: string;
  meta: string;
}



interface Props {
  item: PreviewItem | null;
  onOpen: () => void;
  onClose: () => void;
}

export function CardPreview({ item, onOpen, onClose }: Props) {
  if (!item) return null;

  return (
    <>
      <div className="preview-backdrop" onClick={onClose} />
      <div className="preview-sheet" onClick={onClose} role="dialog" aria-modal="true" aria-label={item.title}>
        <div className="preview-drag-handle" />
        <div className="preview-inner" onClick={(e) => e.stopPropagation()}>
          <div className="preview-top">
            <img className="preview-cover" src={item.coverSrc} alt={item.title} />
            <div className="preview-info">
              <div className="preview-title">{item.title}</div>
              <div className="preview-meta">{item.meta}</div>
              <button
                className="preview-open-btn"
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
              >
                Read →
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
