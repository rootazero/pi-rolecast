from pathlib import Path

REGISTRY_DIR = Path(__file__).resolve().parents[2] / "registry"

def test_built_in_registry_is_valid_yaml():
    import yaml
    data = yaml.safe_load((REGISTRY_DIR / "built_in.yaml").read_text())
    assert "models" in data
    ids = [m["id"] for m in data["models"]]
    assert "claude-opus-5-5" in ids
    assert "deepseek-v4.1-flash" in ids
    assert "gpt-6.1-sol" in ids
    assert "minimax-m3" in ids

def test_built_in_registry_required_fields():
    import yaml
    data = yaml.safe_load((REGISTRY_DIR / "built_in.yaml").read_text())
    for m in data["models"]:
        assert "id" in m
        assert "vendor" in m
        assert "capabilities" in m
        assert "channels" in m and len(m["channels"]) >= 1
        assert "status" in m
        for ch in m["channels"]:
            assert "id" in ch
            assert "trust" in ch

def test_aliases_yaml_references_existing_models():
    import yaml
    reg = yaml.safe_load((REGISTRY_DIR / "built_in.yaml").read_text())
    als = yaml.safe_load((REGISTRY_DIR / "aliases.yaml").read_text())
    model_ids = {m["id"] for m in reg["models"]}
    for name, alias in als["aliases"].items():
        assert alias["preferred"] in model_ids, f"alias {name} -> {alias['preferred']} not in registry"

def test_all_default_aliases_resolve():
    import yaml
    als = yaml.safe_load((REGISTRY_DIR / "aliases.yaml").read_text())
    expected = {
        "opus-thinking-medium", "opus-thinking-high",
        "gpt-judgment-medium", "gpt-judgment-high",
        "deepseek-verifiable",
        "minimax-medium", "minimax-fast",
    }
    assert expected.issubset(als["aliases"].keys())
