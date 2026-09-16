import React from 'react';
import { Loader2 } from 'lucide-react';

// Shared centered loading indicator, used in place of a plain "Loading..."
// text node everywhere a view is waiting on its primary query.
export function LoadingState({ label }: { label: string }) {
  return (
    <div className="view-body">
      <div className="state-message">
        <Loader2 size={24} className="spin" color="var(--text-dim)" />
        <p style={{ marginTop: '8px' }}>{label}</p>
      </div>
    </div>
  );
}

// Shared centered empty state (icon + heading + description), used by any
// view whose primary list can legitimately be empty.
export function EmptyState({
  icon: Icon,
  iconColor,
  title,
  description,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  iconColor: string;
  title: string;
  description: string;
}) {
  return (
    <div className="state-message">
      <div
        className="state-message-icon"
        style={{ backgroundColor: `color-mix(in srgb, ${iconColor} 12%, transparent)` }}
      >
        <Icon size={28} color={iconColor} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
