'use client';

import { useWidgetSDK, useWidgetState } from '@nitrostack/widgets';
import {
  ActionButton,
  ActionFeedback,
  Card,
  Empty,
  Failure,
  Loading,
  errorOf,
  unwrap,
  useToolActions,
  type ToolEnvelope,
} from '../../lib/ui';

interface Category {
  categoryId: string;
  categoryName: string;
  children: Category[];
}

interface CategoryResult {
  treeId: string;
  root: Category;
  truncated?: boolean;
  depth?: number;
}

function countNodes(node: Category): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function CategoryNode({
  category,
  depth,
  expanded,
  toggle,
  actions,
}: {
  category: Category;
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  actions: ReturnType<typeof useToolActions>;
}) {
  const hasChildren = category.children.length > 0;
  // Top-level branches start open; deeper ones stay collapsed so a large
  // taxonomy does not arrive as an unreadable wall.
  const isOpen = expanded[category.categoryId] ?? depth < 1;

  return (
    <div>
      <div className="tree-node">
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${category.categoryName}` : `Expand ${category.categoryName}`}
            onClick={() => toggle(category.categoryId)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-leaf" />
        )}
        <span className="grow truncate" style={{ fontWeight: hasChildren ? 600 : 400, fontSize: 13 }}>
          {category.categoryName}
        </span>
        <span className="faint">{category.categoryId}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={actions.pending !== null}
          onClick={() =>
            actions.run(`browse-${category.categoryId}`, 'search_products', {
              query: category.categoryName,
              category_id: category.categoryId,
              limit: 12,
            })
          }
        >
          Browse
        </button>
      </div>
      {hasChildren && isOpen && (
        <div className="tree-children">
          {category.children.map((child) => (
            <CategoryNode
              key={child.categoryId}
              category={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CategoryTree() {
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<CategoryResult | ToolEnvelope<CategoryResult>>();
  const result = unwrap(output);
  const failure = errorOf(output);
  const actions = useToolActions();
  const [view, setView] = useWidgetState<{ expanded: Record<string, boolean> }>(() => ({ expanded: {} }));

  if (!isReady) return <Loading label="Loading categories…" />;
  if (failure) return <Failure error={failure} />;
  if (!result) return <Empty mark="🗂" title="No categories" hint="Ask the assistant for the eBay category tree." />;

  const expanded = view?.expanded ?? {};
  const toggle = (id: string) =>
    setView({ expanded: { ...expanded, [id]: !(expanded[id] ?? false) } });

  const total = countNodes(result.root) - 1;

  return (
    <Card>
      <div className="stack">
        <div className="header">
          <div className="grow">
            <p className="eyebrow">eBay taxonomy</p>
            <h2 className="title-lg truncate">{result.root.categoryName}</h2>
            <p className="muted">
              {total.toLocaleString()} categor{total === 1 ? 'y' : 'ies'} · tree {result.treeId}
            </p>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                setView({
                  expanded: Object.fromEntries(result.root.children.map((child) => [child.categoryId, true])),
                })
              }
            >
              Expand
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView({ expanded: {} })}>
              Collapse
            </button>
          </div>
        </div>

        {result.truncated && (
          <div className="notice notice-info">
            <span aria-hidden>ℹ</span>
            <span>Deep branches were trimmed to keep this response small. Open a category to load its subtree.</span>
          </div>
        )}

        <ActionFeedback error={actions.error} success={actions.success} />

        <div className="tree">
          {result.root.children.map((child) => (
            <CategoryNode
              key={child.categoryId}
              category={child}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              actions={actions}
            />
          ))}
        </div>

        <ActionButton
          actionKey="full"
          actions={actions}
          label="Load the full tree"
          block
          onClick={() => actions.run('full', 'get_categories', { category_id: '0' })}
        />
      </div>
    </Card>
  );
}
