import type {
  RpcClientPlugin,
  RpcClientPluginHooks,
  RpcPluginShape,
  RpcServerPlugin,
  RpcServerPluginHooks,
  ExplicitRpcValue,
} from './types'

export function rpcClientPlugin<TStub extends object = object, TContext extends object = object>(
  hooks: RpcClientPluginHooks<TStub, TContext>,
): RpcClientPlugin<TStub, TContext> {
  return { client: hooks }
}

export function rpcServerPlugin<TInstance extends object = object, TContext extends object = object>(
  hooks: RpcServerPluginHooks<TInstance, TContext>,
): RpcServerPlugin<TInstance, TContext> {
  return { server: hooks }
}

export function rpcPlugin<TShared extends object = object, TContext extends object = object>(
  shape: RpcClientPlugin<TShared, TContext> & RpcServerPlugin<TShared, TContext>,
): RpcClientPlugin<TShared, TContext> & RpcServerPlugin<TShared, TContext>
export function rpcPlugin<TShared extends object = object, TContext extends object = object>(
  shape: RpcClientPlugin<TShared, TContext>,
): RpcClientPlugin<TShared, TContext>
export function rpcPlugin<TShared extends object = object, TContext extends object = object>(
  shape: RpcServerPlugin<TShared, TContext>,
): RpcServerPlugin<TShared, TContext>
export function rpcPlugin<TShared extends object = object, TContext extends object = object>(
  shape: RpcPluginShape<TShared, TContext>,
): RpcPluginShape<TShared, TContext>
export function rpcPlugin<TShared extends object = object, TContext extends object = object>(
  shape: RpcPluginShape<TShared, TContext>,
): RpcPluginShape<TShared, TContext> {
  return shape
}

export function rpcValue<T>(value: T): ExplicitRpcValue<T> {
  return {
    __mulroyCloudflareRpcExplicitValue: true,
    value,
  }
}
