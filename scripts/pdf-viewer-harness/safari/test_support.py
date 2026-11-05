"""Public, deterministic inputs used only by the offline harness fixtures."""
from safari_settings import ASSETS, Document, Entry, Settings, read_json

DOCUMENT = Document.from_mapping(read_json(ASSETS / 'document.example.json'))
ENTRY = Entry('a' * 64, 1)

def settings(work):
    return Settings(DOCUMENT, ENTRY, work)
