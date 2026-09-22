import { resolveContract, type AssetContractV2 } from "@/lib/asset-registry";

/**
 * Compatibility shim: the v2 contract (from MeshMapping rows on the ACTIVE
 * AssetVersion) is the single source of truth. Legacy imports keep compiling.
 */
export type AssetContract = AssetContractV2;

export async function getAssetContractForVehicle(vehicleId: string): Promise<AssetContract | null> {
  return resolveContract(vehicleId);
}
