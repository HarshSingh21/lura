import { PlacesScreen } from '@/features/places/PlacesScreen';
import { useStore } from '@/state/store';

export default function PlacesRoute() {
  // The top bar owns the search box; the grid reads it from shared state.
  const search = useStore((s) => s.search);
  return <PlacesScreen search={search} />;
}
