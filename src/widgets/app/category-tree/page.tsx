'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';
import { errorMessage, unwrap, type ToolEnvelope } from '../../lib/widget-data';

interface Category {
  categoryId: string;
  categoryName: string;
  children: Category[];
}

interface CategoryResult {
  treeId: string;
  root: Category;
}

function CategoryList({ categories }: { categories: Category[] }) {
  return (
    <ul className="list">
      {categories.map((category) => (
        <li className="list-item" key={category.categoryId}>
          <strong>{category.categoryName}</strong> <span className="muted">({category.categoryId})</span>
          {category.children.length > 0 && <CategoryList categories={category.children} />}
        </li>
      ))}
    </ul>
  );
}

export default function CategoryTree() {
  const theme = useTheme();
  const { getToolOutput, isReady } = useWidgetSDK();
  const output = getToolOutput<CategoryResult | ToolEnvelope<CategoryResult>>();
  const result = unwrap(output);
  const error = errorMessage(output);
  const dark = theme === 'dark';

  if (!isReady) return <div className={`card ${dark ? 'dark' : ''}`}>Loading categories…</div>;
  if (error) return <div className={`card ${dark ? 'dark' : ''}`}><p className="error">{error}</p></div>;
  if (!result) return <div className={`card ${dark ? 'dark' : ''}`}><p className="muted">No categories received.</p></div>;

  return (
    <section className={`card ${dark ? 'dark' : ''}`}>
      <p className="eyebrow">eBay taxonomy</p>
      <h2>{result.root.categoryName}</h2>
      <p className="muted">Category tree: {result.treeId}</p>
      <CategoryList categories={result.root.children} />
    </section>
  );
}
