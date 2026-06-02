export interface Brand {
  id: number;
  name: string;
}

export interface ProductVariant {
  id: number;
  product_id: number;
  sku: string;
  color: string;
}

export interface Product {
  id: number;
  sku: string;
  official_name: string;
  names: string; // 别名，逗号分隔
  brand_id?: number;
  brand_name?: string;
  image_path: string;
  variants?: ProductVariant[];
}

export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
  ext: string;
  previews?: string[];
  products?: (Product & { 
    variant_id?: number; 
    variant_sku?: string; 
    variant_color?: string; 
  })[];
}

export interface UserPermissions {
  canUpload: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canManageProducts: boolean;
  canManageBrands: boolean;
  canTag: boolean;
  canManageUsers?: boolean;
  canManageNewDevelopment?: boolean;
}

export interface User {
  username: string;
  role: string;
  token: string;
  permissions: UserPermissions;
}
