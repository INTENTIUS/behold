import { createComponentExtension, createPlugin } from '@backstage/core-plugin-api';

export const beholdPlugin = createPlugin({ id: 'behold' });

/** The tab's content, for `<EntityLayout.Route path="/infrastructure" title="Infrastructure" if={isBeholdAvailable}>`. */
export const EntityInfrastructureContent = beholdPlugin.provide(
  createComponentExtension({
    name: 'EntityInfrastructureContent',
    component: {
      lazy: () => import('./EntityInfrastructureContent').then(m => m.EntityInfrastructureContent),
    },
  }),
);
