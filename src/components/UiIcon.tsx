import {
  IconChartBar,
  IconHome,
  IconInfoCircle,
  IconPlayerPlay,
} from '@tabler/icons-react';

export function UiIcon({ name }: { name: 'home' | 'play' | 'analysis' | 'about' }) {
  const Icon = name === 'home'
    ? IconHome
    : name === 'play'
      ? IconPlayerPlay
      : name === 'analysis'
        ? IconChartBar
        : IconInfoCircle;
  return <Icon className="ui-icon" size={17} stroke={1.75} aria-hidden="true" />;
}
