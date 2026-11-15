import { createFrontendPlugin, type FrontendPlugin } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { namesSlice } from './slice';

/** The Infrastructure tab. The filter keeps it off entities no annotation picks a slice for. */
const infrastructureContent = EntityContentBlueprint.make({
  name: 'infrastructure',
  params: {
    path: '/infrastructure',
    title: 'Infrastructure',
    filter: entity => namesSlice(entity.metadata.annotations),
    loader: () => import('./EntityInfrastructureContent').then(m => <m.EntityInfrastructureContent />),
  },
});

// Annotated so the declaration does not name a nested package's type (TS2742 on Backstage 1.54).
export const beholdFrontendPlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'behold',
  extensions: [infrastructureContent],
});

export default beholdFrontendPlugin;
