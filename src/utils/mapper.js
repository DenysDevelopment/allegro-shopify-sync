const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class CategoryMapper {
  constructor() {
    this.mapPath = path.join(__dirname, '..', '..', 'config', 'category-map.json');
    this.reload();
  }

  reload() {
    try {
      const raw = fs.readFileSync(this.mapPath, 'utf8');
      this.config = JSON.parse(raw);
      logger.debug(`Category map loaded: ${this.config.mappings.length} mappings`);
    } catch (err) {
      logger.error(`Failed to load category map: ${err.message}`);
      this.config = { default_category_id: null, mappings: [] };
    }
  }

  getAllegroCategory(shopifyProductType, shopifyTags) {
    if (!shopifyProductType && !shopifyTags) return this.config.default_category_id;

    // Try exact match on product_type
    const byType = this.config.mappings.find(
      m => m.shopify_product_type && m.shopify_product_type.toLowerCase() === (shopifyProductType || '').toLowerCase()
    );
    if (byType) return byType.allegro_category_id;

    // Try tag-based matching
    if (shopifyTags) {
      const tags = typeof shopifyTags === 'string'
        ? shopifyTags.split(',').map(t => t.trim().toLowerCase())
        : shopifyTags.map(t => t.toLowerCase());

      const byTag = this.config.mappings.find(m =>
        m.shopify_tags && m.shopify_tags.some(t => tags.includes(t.toLowerCase()))
      );
      if (byTag) return byTag.allegro_category_id;
    }

    return this.config.default_category_id;
  }

  mapAttributes(shopifyProduct, allegroCategoryId) {
    const mapping = this.config.mappings.find(
      m => m.allegro_category_id === allegroCategoryId
    );
    if (!mapping?.parameter_map) return [];

    return mapping.parameter_map
      .map(pm => {
        const value = this._resolveField(shopifyProduct, pm.shopify_field);
        if (!value) return null;

        // If value_map has a mapping, use valuesIds
        if (pm.value_map && pm.value_map[value]) {
          return {
            id: pm.allegro_param_id,
            valuesIds: [pm.value_map[value]],
          };
        }

        // Otherwise use raw values
        return {
          id: pm.allegro_param_id,
          values: [String(value)],
        };
      })
      .filter(Boolean);
  }

  getDefaults() {
    return {
      shippingRateId: this.config.default_shipping_rate_id,
      returnPolicyId: this.config.default_return_policy_id,
      impliedWarrantyId: this.config.default_implied_warranty_id,
      location: this.config.default_location,
    };
  }

  _resolveField(product, fieldPath) {
    if (!fieldPath) return null;

    // Support dotted paths like "metafields.cpu"
    const parts = fieldPath.split('.');
    let value = product;
    for (const part of parts) {
      if (value == null) return null;
      value = value[part];
    }
    return value;
  }
}

module.exports = new CategoryMapper();
