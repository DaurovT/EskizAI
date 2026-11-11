"""Ядро мебельного конструктора: дерево модулей → модель деталей → смета, раскрой, файлы.

Публичный API (стабильный список; внутренние модули могут меняться):
"""

from .assembler import BuildResult, build, parse_tree
from .catalog import EDGE_TYPES, MATERIALS, Material, edge_type, material
from .estimate import Estimate, EstimateRange, PricingSettings, client_view, estimate, estimate_range
from .exports.csv_cut import export_csv
from .exports.dxf_parts import export_dxf_zip, part_dxf
from .exports.pdf import (
    export_assembly_pdf,
    export_cutmaps_pdf,
    export_general_view_pdf,
    export_kp_pdf,
    export_part_drawings_pdf,
    export_spec_pdf,
)
from .exports.usdz import export_usdz
from .exports.xlsx import export_xlsx
from .fixes import apply_fix, apply_patch
from .glb import ar_placement, export_glb
from .hardware import HardwareGroup, hardware_options
from .kitchen_site import fit_kitchen
from .migrate import apply_measurements, migrate_tree
from .niche import fit_to_niche
from .nesting import Nesting, nest
from .order import SupplierOrder, delivery_cost, supplier_order
from .parts import Fix, Issue, Part, PatchOp
from .pricing import DEMO_PRICES, PriceBook, PriceItem
from .rules import DEFAULT_RULES, RuleSet
from .schema import Builtin, Kitchen, KitchenSite, Niche, Product
from .viewer import viewer_model

__all__ = [
    "build", "parse_tree", "BuildResult", "Product", "Kitchen", "KitchenSite", "fit_kitchen", "Part", "Issue", "Fix", "PatchOp",
    "viewer_model", "export_glb", "export_usdz", "ar_placement", "nest", "Nesting",
    "estimate", "estimate_range", "client_view", "PricingSettings", "Estimate", "EstimateRange",
    "export_csv", "export_dxf_zip", "part_dxf", "export_xlsx",
    "export_spec_pdf", "export_cutmaps_pdf", "export_part_drawings_pdf", "export_general_view_pdf",
    "export_assembly_pdf", "export_kp_pdf",
    "apply_fix", "apply_patch", "migrate_tree", "apply_measurements", "fit_to_niche", "Niche", "Builtin",
    "supplier_order", "SupplierOrder", "delivery_cost", "PriceBook", "PriceItem", "DEMO_PRICES",
    "hardware_options", "HardwareGroup",
    "MATERIALS", "Material", "material", "EDGE_TYPES", "edge_type", "DEFAULT_RULES", "RuleSet",
]
