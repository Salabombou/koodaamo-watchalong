from PySide6.QtCore import QAbstractListModel, QModelIndex, Qt, Slot


class ParticipantsModel(QAbstractListModel):
    _roles = {Qt.ItemDataRole.UserRole + offset: name.encode() for offset, name in enumerate(
        ("peerId", "displayName", "ready", "loaded", "ignored", "participating", "isHost", "isSelf"), 1)}

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._rows: list[dict] = []

    def roleNames(self) -> dict:
        return self._roles

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._rows)

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid() or not 0 <= index.row() < len(self._rows):
            return None
        key = self._roles.get(role)
        return self._rows[index.row()].get(key.decode()) if key is not None else None

    @Slot(int, result="QVariantMap")
    def get(self, index: int) -> dict:
        return dict(self._rows[index]) if 0 <= index < len(self._rows) else {}

    def update(self, records: list[dict]) -> None:
        incoming = {record["peerId"]: record for record in records}
        for row in range(len(self._rows) - 1, -1, -1):
            if self._rows[row]["peerId"] not in incoming:
                self.beginRemoveRows(QModelIndex(), row, row)
                self._rows.pop(row)
                self.endRemoveRows()
        known = {record["peerId"] for record in self._rows}
        for record in records:
            if record["peerId"] not in known:
                row = len(self._rows)
                self.beginInsertRows(QModelIndex(), row, row)
                self._rows.append(dict(record))
                self.endInsertRows()
        for row, record in enumerate(self._rows):
            replacement = incoming[record["peerId"]]
            if record != replacement:
                self._rows[row] = dict(replacement)
                self.dataChanged.emit(self.index(row), self.index(row), list(self._roles))