import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
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

export const beholdFrontendPlugin = createFrontendPlugin({
  pluginId: 'behold',
  extensions: [infrastructureContent],
});

export default beholdFrontendPlugin;
