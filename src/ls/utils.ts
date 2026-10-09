// copied from https://github.com/evidence-dev/evidence/blob/main/packages/bigquery/index.cjs
const standardizeResult = async (result: any[]): Promise<any[]> => {
	var output = [];
	result.forEach((row) => {
		const standardized = {};
		for (const [key, value] of Object.entries(row)) {
			if (Array.isArray(value)) {
				standardized[key] = value.map((v) => {
					if (v['value']) {
						return v['value'];
					} else {
						return v;
					}
				});
			} else if (typeof value === 'object') {
				if (value) {
					if (value['value']) {
						standardized[key] = value['value'];
					} else {
						//This is a bigQuery specific workaround for https://github.com/evidence-dev/evidence/issues/792
						try {
							standardized[key] = Number(value);
						} catch (err) {
							standardized[key] = value;
						}
					}
				} else {
					standardized[key] = null;
				}
			} else {
				standardized[key] = value;
			}
		}
		output.push(standardized);
	});
	return output;
};

const formatDuration = (milliseconds: number): string => {
	const totalSeconds = Math.max(0, Number(milliseconds) || 0) / 1000;
	if (totalSeconds < 60) {
		return `${totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1).replace(/\.?0+$/, '')}sec`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = Math.floor(totalSeconds % 60);
		return `${totalMinutes}min${seconds ? ` ${seconds}sec` : ''}`;
	}
	const minutes = totalMinutes % 60;
	return `${Math.floor(totalMinutes / 60)}h${minutes ? ` ${minutes}min` : ''}`;
};

const matchesCompletionName = (name: string, search: string): boolean => {
	const normalizedName = name.toLowerCase();
	const normalizedSearch = search.toLowerCase();
	let position = 0;
	for (const character of normalizedSearch) {
		position = normalizedName.indexOf(character, position);
		if (position === -1) return false;
		position++;
	}
	return true;
};

export {
    standardizeResult,
    formatDuration,
    matchesCompletionName
}