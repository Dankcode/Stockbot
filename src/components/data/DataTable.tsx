import type { ReactNode } from "react";

export type DataColumn<Row> = {
  key: string;
  header: string;
  numeric?: boolean;
  className?: string;
  render: (row: Row) => ReactNode;
};

type DataTableProps<Row> = {
  columns: DataColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  selectedRow?: (row: Row) => boolean;
  label: string;
};

export function DataTable<Row>({ columns, rows, rowKey, onRowClick, selectedRow, label }: DataTableProps<Row>) {
  return (
    <div className="table-scroll">
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={`${column.numeric ? "numeric" : ""} ${column.className ?? ""}`.trim()}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={rowKey(row)}
                className={`${clickable ? "clickable" : ""}${selectedRow?.(row) ? " selected" : ""}`}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={clickable ? (event) => event.key === "Enter" && onRowClick?.(row) : undefined}
                tabIndex={clickable ? 0 : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={`${column.numeric ? "numeric" : ""} ${column.className ?? ""}`.trim()}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
